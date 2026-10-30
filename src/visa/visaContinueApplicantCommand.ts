import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { findApplicantGroupId, findQueueRecordByApplicantId, flagAmbiguousForReview } from '../db/repositories/visaSubmissionQueue.repo.js';
import { finalizeApplicantSubmission, requestTransition } from './visaSubmissionQueueOrchestrator.js';
import { buildPostgresVisaSubmissionQueueStore } from './visaSubmissionQueuePostgresStore.js';
import type { VisaSubmissionQueueStore } from './visaSubmissionQueueStore.js';
import type { VisaSubmissionStatus } from './visaSubmissionStatus.js';
import { getConfiguredVisitSaudiSession } from './visaStartSubmissionCommand.js';
import type { VisitSaudiSessionAvailability } from './visitSaudiActiveSession.js';
import { isAnchorVisible } from './visitSaudiPageActions.js';

/**
 * Page 3's own confirmed anchor -- the SAME string createVisitSaudiGroup
 * (visitSaudiPageActions.ts) already relies on to confirm a NEW Page 3
 * has genuinely loaded. Reused here, unchanged, never a newly-invented
 * selector: its reappearance after an operator's real, by-hand
 * continuation action is the ONE piece of EXISTING, confirmed evidence
 * this command can check without guessing Page 6/7's own (still
 * unconfirmed) anchors or the real continue action's own exact
 * button/link text -- see this file's own doc comment below.
 */
const PAGE_3_ANCHOR_TEXT = 'UPLOAD FILE';

export type VisaContinueApplicantCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  /** Same never-leaking outcome as visaStopApplicantCommand.ts / visaCheckAmbiguousCommand.ts: unknown id or a different group's applicant. */
  | { kind: 'APPLICANT_NOT_FOUND' }
  /** The applicant has no submission_queue row at all -- same naming convention as visaCheckAmbiguousCommand.ts's own NO_QUEUE_RECORD. */
  | { kind: 'NO_QUEUE_RECORD' }
  /**
   * The queue row's CURRENT status is not AWAITING_MANUAL_CONTINUATION --
   * this command only ever applies to that one status, never any other
   * (including a SECOND concurrent call for the SAME applicant that lost
   * the race below -- see this function's own doc comment).
   */
  | { kind: 'NOT_AWAITING_MANUAL_CONTINUATION'; currentStatus: VisaSubmissionStatus }
  /**
   * No active, usable VisitSaudi browser session -- same NO_ACTIVE_SESSION
   * convention and `reason` semantics as visaStartSubmissionCommand.ts.
   * NOTHING is attempted or transitioned when this is returned -- the
   * queue row stays exactly AWAITING_MANUAL_CONTINUATION, so a later
   * retry (once a session IS available) can still succeed. This is the
   * fix for this package's own prior gap: the earlier implementation
   * transitioned the row to AMBIGUOUS unconditionally, with NO browser
   * session involved at all -- that was never a real continuation check,
   * only a status-bookkeeping no-op dressed up as one.
   */
  | { kind: 'NO_ACTIVE_SESSION'; reason: string }
  | { kind: 'CONTINUED'; nextApplicantPage3Observed: boolean }
  /** The AWAITING_MANUAL_CONTINUATION -> SUBMITTING claim itself succeeded, but the immediately-following SUBMITTING -> AMBIGUOUS finalize was unexpectedly rejected -- never silently swallowed. */
  | { kind: 'CONTINUE_FAILED'; detail: string };

export interface VisaContinueApplicantCommandInput {
  telegramChatId: number;
  authorStatus: string;
  visaBatchApplicantId: string;
}

export interface VisaContinueApplicantCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findApplicantGroupId: typeof findApplicantGroupId;
  findQueueRecordByApplicantId: typeof findQueueRecordByApplicantId;
  flagAmbiguousForReview: typeof flagAmbiguousForReview;
  buildQueueStore: () => VisaSubmissionQueueStore;
  /** Reuses the EXACT SAME env-gated CDP-connection decision as visaStartSubmissionCommand.ts's own getConfiguredVisitSaudiSession -- never a second, parallel "is a session configured" implementation. Defaults to OFF (always unavailable) unless VISITSAUDI_CDP_ENDPOINT is explicitly set, same as that file. */
  getActiveSession: (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability>;
  nowMs: () => number;
}

const defaultDependencies: VisaContinueApplicantCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findApplicantGroupId,
  findQueueRecordByApplicantId,
  flagAmbiguousForReview,
  buildQueueStore: buildPostgresVisaSubmissionQueueStore,
  getActiveSession: getConfiguredVisitSaudiSession,
  nowMs: () => Date.now(),
};

/**
 * ============================================================================
 * The "DAVOM ETISH" (CONTINUE) operator action's command-core -- now
 * genuinely connected to the browser session (previous step's own
 * SUBMITTING->AMBIGUOUS status flip, with no session involved at all,
 * was NOT a real continuation check -- see NO_ACTIVE_SESSION's own doc
 * comment above for exactly what that gap was and how this closes it).
 * ============================================================================
 *
 * WHAT THIS MODELS: the operator has already, by hand, on the real
 * browser tab, manually completed Pages 5 (Insurance consent), 6 (Terms
 * and Conditions), and 7 (Review Application, including the real
 * continue/SAVE action) for ONE applicant that automation left at
 * AWAITING_MANUAL_CONTINUATION (visitSaudiBrowserAutomationAdapter.ts's
 * own known handoff point). Typing /visa_continue_applicant INFORMS this
 * codebase of that fact -- it never drives the browser itself, never
 * clicks anything, and never guesses what the real portal actually did.
 *
 * WHY A REAL SESSION IS NOW REQUIRED, NEVER OPTIONAL: without one, this
 * command has ZERO way to check anything about the real portal's current
 * state, so pretending to "continue" by only flipping a DB status (this
 * package's own prior behavior) was fake success -- it looked like a
 * real action but verified nothing. Now, if deps.getActiveSession
 * reports unavailable, this returns NO_ACTIVE_SESSION and changes
 * NOTHING -- the row stays AWAITING_MANUAL_CONTINUATION.
 *
 * WHAT THE SESSION IS ACTUALLY USED FOR, AND WHY NOT MORE: this command
 * performs exactly ONE safe, non-throwing check (isAnchorVisible,
 * visitSaudiPageActions.ts, already tested) for Page 3's own confirmed
 * anchor ("UPLOAD FILE", the SAME one createVisitSaudiGroup already
 * relies on). If it is visible again, that is the closest EXISTING,
 * confirmed evidence available that the browser genuinely advanced to a
 * NEW applicant's own Page 3 -- consistent with (though not identical
 * to) what visaStartSubmissionCommand.ts's own VISITSAUDI_RESUMED_SESSION_ANCHOR_TEXTS
 * already uses this exact anchor for: recognizing "the browser is on
 * SOME applicant's Page 3" without guessing navigation. This command
 * deliberately goes NO FURTHER than that one check: no confirmed anchor
 * exists anywhere in this codebase for Page 6 or Page 7 (see
 * visitSaudiBrowserAutomationAdapter.ts's own Page3->Page7 flow-fix doc
 * comment), and the real Page 7 continue action's own exact button/link
 * text is also still unconfirmed -- so nothing on those pages is checked
 * or clicked, and no new selector is invented for them.
 *
 * WHY THE RESULT IS ALWAYS AMBIGUOUS, NEVER SAVED, EVEN WHEN THE ANCHOR
 * IS OBSERVED: Page 3's anchor reappearing is still only CIRCUMSTANTIAL
 * evidence -- not a direct save-confirmation signal (no toast, no
 * counter, no explicit "saved" indicator has ever been observed on the
 * real portal; confirmSaveOutcome, visitSaudiPageActions.ts, remains
 * deliberately un-implemented for exactly this reason). Treating it as
 * proof of SAVED would be exactly the kind of guess this engagement never
 * makes. What DOES change based on the observation is the `detail`
 * recorded via flagAmbiguousForReview below, and the
 * `nextApplicantPage3Observed` field on the CONTINUED outcome itself --
 * both honestly report what was actually seen, as real, durable evidence
 * for a human (or a future, separately-evidenced phase) to build on.
 *
 * WHY THE TRANSITION STILL GOES THROUGH SUBMITTING FIRST, ATOMICALLY:
 * exactly as before -- requestTransition's compare-and-swap (never raw
 * SQL) is what makes two concurrent /visa_continue_applicant calls for
 * the SAME applicant safe: only the FIRST call's attempt (expecting
 * AWAITING_MANUAL_CONTINUATION) can possibly succeed; the second is
 * atomically rejected as a current-status mismatch and reported back as
 * NOT_AWAITING_MANUAL_CONTINUATION, never a duplicate submission.
 *
 * NEVER returns to PENDING, NEVER recreates a batch or applicant, and
 * NEVER adds a new outgoing transition away from AMBIGUOUS (it stays
 * terminal, unchanged from visaSubmissionStatus.ts's own rule table).
 * NEVER checks or clicks Page 5/6/7's own consent/declaration checkboxes,
 * and NEVER reaches `PAY FOR GROUP` / `AGREE & COMPLETE PAYMENT` -- this
 * command only ever reads one already-confirmed anchor's visibility.
 *
 * STILL NOT DONE in this step (deliberately, per this phase's own scope):
 * this command does not yet resume AUTOMATING the next applicant's own
 * Page 3/4 fields -- it only checks whether the browser already appears
 * to be there. A future, separately-evidenced phase may use this same
 * AWAITING_MANUAL_CONTINUATION -> SUBMITTING claim as the entry point for
 * actually driving that automation once Page 3 -> Page 4's own trigger
 * and Page 6/7's own anchors are confirmed -- out of scope here.
 */
export async function visaContinueApplicantCommand(
  input: VisaContinueApplicantCommandInput,
  deps: VisaContinueApplicantCommandDependencies = defaultDependencies,
): Promise<VisaContinueApplicantCommandOutcome> {
  if (input.authorStatus !== 'creator' && input.authorStatus !== 'administrator') {
    return { kind: 'UNAUTHORIZED' };
  }

  const group = await deps.findGroup(input.telegramChatId);
  if (!group) {
    return { kind: 'GROUP_NOT_FOUND' };
  }

  const applicantGroupId = await deps.findApplicantGroupId(input.visaBatchApplicantId);
  if (!applicantGroupId || applicantGroupId !== group.id) {
    return { kind: 'APPLICANT_NOT_FOUND' };
  }

  const queueRecord = await deps.findQueueRecordByApplicantId(input.visaBatchApplicantId);
  if (!queueRecord) {
    return { kind: 'NO_QUEUE_RECORD' };
  }

  if (queueRecord.status !== 'AWAITING_MANUAL_CONTINUATION') {
    return { kind: 'NOT_AWAITING_MANUAL_CONTINUATION', currentStatus: queueRecord.status };
  }

  const session = await deps.getActiveSession(PAGE_3_ANCHOR_TEXT);
  if (!session.available) {
    // Never fake success -- see this file's own NO_ACTIVE_SESSION doc
    // comment above. Nothing is attempted or transitioned.
    return { kind: 'NO_ACTIVE_SESSION', reason: session.reason };
  }

  try {
    const nextApplicantPage3Observed = await isAnchorVisible(session.page, PAGE_3_ANCHOR_TEXT);

    const store = deps.buildQueueStore();
    const nowMs = deps.nowMs();

    const claim = await requestTransition(store, queueRecord.id, 'AWAITING_MANUAL_CONTINUATION', 'SUBMITTING', nowMs);
    if (!claim.ok) {
      // Lost a race against a concurrent call (or some other transition)
      // between the read above and this atomic check-and-set -- re-read
      // to report the NOW-current status, never guessed. The compare-
      // and-swap itself is what actually prevents two concurrent calls
      // from both succeeding; this re-read is purely to report an
      // accurate reason.
      const refreshed = await deps.findQueueRecordByApplicantId(input.visaBatchApplicantId);
      return { kind: 'NOT_AWAITING_MANUAL_CONTINUATION', currentStatus: refreshed?.status ?? queueRecord.status };
    }

    const detail = nextApplicantPage3Observed
      ? `operator confirmed manual continuation (Pages 5-7, including the real continue/SAVE action) via /visa_continue_applicant for visa_batch_applicant ${input.visaBatchApplicantId}; the browser now shows Page 3's own confirmed anchor ("${PAGE_3_ANCHOR_TEXT}") again, consistent with having advanced to a new applicant -- still not an independent save-confirmation signal (no such signal has ever been observed on the real portal), so this is recorded as AMBIGUOUS rather than assumed saved`
      : `operator confirmed manual continuation (Pages 5-7, including the real continue/SAVE action) via /visa_continue_applicant for visa_batch_applicant ${input.visaBatchApplicantId}; Page 3's own confirmed anchor ("${PAGE_3_ANCHOR_TEXT}") was NOT observed on the current browser page -- page state is unconfirmed, recorded as AMBIGUOUS rather than assumed saved`;

    const finalize = await finalizeApplicantSubmission(store, queueRecord.id, 'AMBIGUOUS', nowMs);
    if (!finalize.ok) {
      return {
        kind: 'CONTINUE_FAILED',
        detail: `claimed AWAITING_MANUAL_CONTINUATION -> SUBMITTING but could not finalize to AMBIGUOUS: ${finalize.reason}`,
      };
    }

    await deps.flagAmbiguousForReview(queueRecord.id, detail);

    return { kind: 'CONTINUED', nextApplicantPage3Observed };
  } finally {
    // Package 5.45's own established convention (visaStartSubmissionCommand.ts):
    // the CDP connection this session carries is always released here,
    // once this call is fully done -- success or failure -- never left
    // open across commands. release() disconnects ONLY this connection,
    // never the operator's own Chrome, profile, or pre-existing tabs.
    await session.release();
  }
}
