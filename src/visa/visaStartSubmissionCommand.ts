import type { Page } from 'playwright';
import { env } from '../config/env.js';
import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { findActiveApplicantPositionsForBatch, findLastBatchForGroup } from '../db/repositories/visaBatches.repo.js';
import { countQueueStatusesForBatch, findPendingQueueApplicantsForBatch } from '../db/repositories/visaSubmissionQueue.repo.js';
import type { VisaApplicantAutomationAdapter } from './visaApplicantAutomationAdapter.js';
import { buildVisitSaudiBrowserAutomationAdapter } from './visitSaudiBrowserAutomationAdapter.js';
import { checkVisitSaudiApplicantPreflight } from './visitSaudiPreflight.js';
import {
  buildPostgresVisaBatchLockStore,
  buildPostgresVisaSubmissionQueueStore,
} from './visaSubmissionQueuePostgresStore.js';
import type { VisaBatchLockStore, VisaSubmissionQueueStore } from './visaSubmissionQueueStore.js';
import { startVisitSaudiBatchSubmission } from './startVisitSaudiBatchSubmission.js';
import { runVisaWorkerLoopForBatch, type VisaWorkerLoopApplicantInput, type VisaWorkerLoopDependencies } from './visaWorkerLoop.js';
import { buildVisaBatchSubmissionOperatorSummary } from './visaSubmissionResultMessage.js';
import { getNoActiveVisitSaudiSession, getVisitSaudiSessionOverCdp, type VisitSaudiSessionAvailability } from './visitSaudiActiveSession.js';

/**
 * Page 1 (post-login "Apply for eVisa" dashboard)'s own confirmed text
 * (clickApplyForGroup, visitSaudiPageActions.ts) -- the SAME anchor
 * createVisitSaudiGroup's own first action looks for. On a FRESH batch
 * the operator is expected to leave Chrome on exactly this page before
 * triggering /visa_start_submission; reusing this already-confirmed
 * string (rather than inventing a new one) means "the session is on the
 * right page" and "createVisitSaudiGroup's own first click will succeed"
 * are the SAME check, not two independently-guessed ones.
 */
const VISITSAUDI_DASHBOARD_ANCHOR_TEXT = 'APPLY FOR GROUP';

/**
 * Package 5.46: on a RESUMED batch (see batchAlreadyStarted below),
 * createVisitSaudiGroup is never called again -- which means the
 * operator's tab is, by the normal flow of this exact codebase's own
 * automation, no longer on the dashboard at all. It is wherever the
 * earlier run's last successful action left it: some applicant's own
 * Page 3 (personal info -- "Country of Nationality" is a real,
 * already-relied-on field label, fillApplicantPersonalInfoFields,
 * visitSaudiPageActions.ts), Page 4 ("Passport Type", the SAME confirmed
 * anchor fillApplicantTripDetailsFields itself already asserts), or
 * Page 5 ("INSURANCE COVERAGE", the SAME confirmed anchor
 * confirmInsuranceConsent itself already asserts). Searching for ANY ONE
 * of these -- every one already a confirmed, evidence-backed string this
 * codebase already relies on elsewhere, never a newly-guessed one -- lets
 * session discovery actually succeed after a genuine resume, instead of
 * always reporting NO_ACTIVE_SESSION just because the dashboard anchor is
 * (correctly, expectedly) gone by then. The dashboard anchor is kept in
 * this list too, purely defensively, for the unlikely case a resume is
 * triggered before the browser ever left it.
 *
 * NOT CONFIRMED, and deliberately not guessed at: what the portal shows
 * immediately after the batch's VERY LAST applicant's own SAVE click (no
 * further page in this flow has ever been observed/confirmed -- see
 * visitSaudiBrowserAutomationAdapter.ts's own doc comment, step 5). If a
 * drop happens at EXACTLY that moment, none of the anchors below may
 * match and this will correctly, safely report NO_ACTIVE_SESSION rather
 * than guess a new anchor -- this is a real, named gap, not an oversight
 * (see this package's own final report).
 */
const VISITSAUDI_RESUMED_SESSION_ANCHOR_TEXTS: readonly string[] = [
  VISITSAUDI_DASHBOARD_ANCHOR_TEXT,
  'Country of Nationality',
  'Passport Type',
  'INSURANCE COVERAGE',
];

/**
 * Package 5.45 (Phase 2e / B-bosqich): the REAL `getActiveSession`
 * default. Reads VISITSAUDI_CDP_ENDPOINT (env.schema.ts, optional,
 * unset by default) -- when unset, delegates straight to
 * getNoActiveVisitSaudiSession (byte-for-byte the SAME safe, always-
 * unavailable behavior as before this package). Only when an operator
 * has explicitly configured an endpoint does this attempt an actual CDP
 * connection, via getVisitSaudiSessionOverCdp (visitSaudiActiveSession.ts
 * -- never a parallel connection mechanism). This is the ONE place in
 * this file that reads `env` or decides whether CDP is "on" -- kept out
 * of visitSaudiActiveSession.ts so that file stays fully DB/env-free and
 * directly testable without a database (see its own doc comment).
 *
 * Package 5.46: takes `anchorTexts` as a parameter (rather than always
 * using the dashboard anchor) so the caller -- which already knows,
 * from countQueueStatuses, whether this is a FRESH or RESUMED run --
 * decides which anchor set is correct; this function itself makes no
 * fresh/resumed decision of its own.
 */
/** Exported so visaContinueApplicantCommand.ts can reuse the SAME env-gated CDP-connection decision -- never a second, parallel implementation of "is a VisitSaudi session configured." */
export async function getConfiguredVisitSaudiSession(anchorTexts: string | readonly string[]): Promise<VisitSaudiSessionAvailability> {
  if (!env.VISITSAUDI_CDP_ENDPOINT) {
    return getNoActiveVisitSaudiSession();
  }
  return getVisitSaudiSessionOverCdp(env.VISITSAUDI_CDP_ENDPOINT, anchorTexts);
}

/**
 * ============================================================================
 * Package 5.43 -- minimal, safe Phase 2e bot integration: connects the
 * ALREADY-EXISTING startVisitSaudiBatchSubmission/runVisaWorkerLoopForBatch
 * chain (queue store, batch lock, real browser adapter, preflight, the
 * 10-applicant SAVE/SAVE-AND-MOVE-TO-THE-NEXT-APPLICANT rule, the
 * operatorSummaryText builder) to a real Telegram command -- NOTHING new
 * is built in parallel; every dependency below is the SAME, already-
 * tested production implementation this engagement already has.
 * ============================================================================
 *
 * `getActiveSession` DEFAULTS to getConfiguredVisitSaudiSession (above),
 * which is OFF (always unavailable) unless an operator has explicitly set
 * VISITSAUDI_CDP_ENDPOINT. Package 5.43's own audit (grep -rl
 * "chromium|playwright|BrowserContext" src/) found NO browser/session
 * lifecycle manager and NO authentication mechanism anywhere in this
 * codebase -- this engagement's own standing rule has always been "the
 * user performs portal login manually" (see
 * startVisitSaudiBatchSubmission.ts's own doc comment); there is still no
 * stored credential and no automated login flow. Package 5.45 (Phase 2e
 * / B-bosqich) closes the REMAINING gap -- how a human's manually-opened,
 * already-logged-in VisitSaudi browser Page reaches this process -- via
 * an operator-run reverse SSH tunnel exposing Chrome's own
 * --remote-debugging-port, connected to here over CDP
 * (connectToVisitSaudiSessionOverCdp, visitSaudiActiveSession.ts). This
 * process (the bot) NEVER opens a port to the public internet itself,
 * NEVER stores a credential, and NEVER attempts to log in -- it only
 * connects, as a CDP CLIENT, to whatever loopback endpoint the operator's
 * own tunnel makes available, and only when VISITSAUDI_CDP_ENDPOINT is
 * explicitly set. Any failure mode (not configured, tunnel/Chrome
 * unreachable, expected tab not found, several candidate tabs found)
 * resolves to NO_ACTIVE_SESSION with its own specific `reason` -- never
 * guessed, never silently skipped, never a fabricated session.
 *
 * This file's own CDP logic runs ENTIRELY inside the bot process -- the
 * separate `visa:worker` process (src/visa/start.ts) is untouched by this
 * package and still never opens a browser or a CDP connection of its
 * own; no attempt is made to share this session across processes.
 *
 * CAPTCHA, OTP, the Legal Declaration page, `PAY FOR GROUP`, and
 * `AGREE & COMPLETE PAYMENT` are never reachable from this command,
 * directly or indirectly -- it only ever calls startVisitSaudiBatchSubmission,
 * whose own full chain already never targets any of those (see that
 * file's and visitSaudiBrowserAutomationAdapter.ts's own doc comments).
 */
export type VisaStartSubmissionCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  | { kind: 'NO_BATCH' }
  /** No PENDING visa_submission_queue rows for this batch -- never queued yet (/visa_queue_batch not run), or every queued row already reached SAVED/ERROR/AMBIGUOUS. Nothing is attempted. */
  | { kind: 'NOTHING_QUEUED'; batchName: string }
  /** No active, usable VisitSaudi browser session -- `reason` (Package 5.45) names exactly which case: not configured, tunnel/Chrome unreachable, expected tab not found, or multiple candidate tabs found. Nothing is attempted; never guessed as any other outcome. */
  | { kind: 'NO_ACTIVE_SESSION'; batchName: string; reason: string }
  /** createVisitSaudiGroup or runVisaWorkerLoopForBatch itself threw before producing a result (e.g. a locator never resolved) -- never guessed as SAVED, never silently swallowed. */
  | { kind: 'START_FAILED'; batchName: string; detail: string }
  /** The run completed (lock acquired and applicants processed, OR the batch was already locked by another worker, OR the given list failed its own completeness/order validation) -- operatorSummaryText (startVisitSaudiBatchSubmission's own, already-tested builder) already states which case this is and, per applicant, whether a hotel-autocomplete/Page-5/Insurance caveat applies. Never post-processed or re-worded here. */
  | { kind: 'STARTED'; batchName: string; operatorSummaryText: string };

export interface VisaStartSubmissionCommandInput {
  telegramChatId: number;
  /** Same 'creator' | 'administrator' rule as every other VisitSaudi command in this codebase. */
  authorStatus: string;
  /** The operator's own identity -- same `telegram:${username ?? id}` convention bot.ts already uses for /visa_queue_batch's own requestedBy, reused here as the worker loop's own workerId (batch-lock ownership). */
  requestedBy: string;
}

export interface VisaStartSubmissionCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findLastBatch: typeof findLastBatchForGroup;
  findPendingQueueApplicants: typeof findPendingQueueApplicantsForBatch;
  findActiveApplicantPositions: typeof findActiveApplicantPositionsForBatch;
  countQueueStatuses: typeof countQueueStatusesForBatch;
  buildQueueStore: () => VisaSubmissionQueueStore;
  buildLockStore: () => VisaBatchLockStore;
  checkPreflight: typeof checkVisitSaudiApplicantPreflight;
  buildAutomation: (page: Page) => VisaApplicantAutomationAdapter;
  /** See this file's own doc comment. Defaults to getConfiguredVisitSaudiSession -- off (always unavailable) unless VISITSAUDI_CDP_ENDPOINT is explicitly set. The caller passes the anchor set that matches whether this is a FRESH or RESUMED run (Package 5.46) -- this slot itself is never hardcoded to one page. */
  getActiveSession: (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability>;
  nowMs: () => number;
}

/** Exported (unlike this codebase's other *Command.ts files' own local-only defaultDependencies) specifically so a DB-integration test can override JUST the genuinely-external pieces (getActiveSession, checkPreflight) via `{ ...defaultDependencies, ... }`, while every other field stays this module's own real, Postgres-backed implementation -- never a parallel, hand-reconstructed copy of this wiring. */
export const defaultDependencies: VisaStartSubmissionCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findLastBatch: findLastBatchForGroup,
  findPendingQueueApplicants: findPendingQueueApplicantsForBatch,
  findActiveApplicantPositions: findActiveApplicantPositionsForBatch,
  countQueueStatuses: countQueueStatusesForBatch,
  buildQueueStore: buildPostgresVisaSubmissionQueueStore,
  buildLockStore: buildPostgresVisaBatchLockStore,
  checkPreflight: checkVisitSaudiApplicantPreflight,
  buildAutomation: buildVisitSaudiBrowserAutomationAdapter,
  getActiveSession: getConfiguredVisitSaudiSession,
  nowMs: () => Date.now(),
};

/**
 * Operator command: starts (or RESUMES) the group's current VisitSaudi
 * batch's real submission run, for every applicant currently PENDING in
 * the queue (visa_queue_batch's own earlier output); never reprocesses an
 * applicant already SAVED/ERROR/AMBIGUOUS/SUBMITTING (those are simply
 * not PENDING, so findPendingQueueApplicantsForBatch never returns them
 * -- the SAME claim-based protection runVisaWorkerLoopForBatch's own
 * claimApplicantForSubmission already enforces independently).
 *
 * Package 5.46: a FRESH batch (no queue row for it has EVER left PENDING)
 * goes through startVisitSaudiBatchSubmission -- group creation, then the
 * unmodified, already-tested worker loop. A RESUMED batch (some row
 * already SUBMITTING/SAVED/ERROR/AMBIGUOUS -- e.g. a previous run's
 * tunnel dropped mid-batch) calls runVisaWorkerLoopForBatch DIRECTLY,
 * skipping group creation entirely -- see this function's own inline
 * comment for why re-clicking APPLY FOR GROUP on a resume would be an
 * unconfirmed navigation guess.
 *
 * Never opens, logs into, or navigates a browser itself -- `page` comes
 * ENTIRELY from deps.getActiveSession (see this file's own doc comment).
 */
export async function visaStartSubmissionCommand(
  input: VisaStartSubmissionCommandInput,
  deps: VisaStartSubmissionCommandDependencies = defaultDependencies,
): Promise<VisaStartSubmissionCommandOutcome> {
  if (input.authorStatus !== 'creator' && input.authorStatus !== 'administrator') {
    return { kind: 'UNAUTHORIZED' };
  }

  const group = await deps.findGroup(input.telegramChatId);
  if (!group) {
    return { kind: 'GROUP_NOT_FOUND' };
  }

  const batch = await deps.findLastBatch(group.id, 'visitsaudi');
  if (!batch) {
    return { kind: 'NO_BATCH' };
  }

  const pendingApplicants = await deps.findPendingQueueApplicants(batch.id);
  if (pendingApplicants.length === 0) {
    return { kind: 'NOTHING_QUEUED', batchName: batch.batchName };
  }

  // Package 5.46: a RESUMED batch (one or more queue rows already
  // SUBMITTING/SAVED/ERROR/AMBIGUOUS/AWAITING_MANUAL_CONTINUATION) must
  // NEVER call createVisitSaudiGroup again -- startVisitSaudiBatchSubmission.ts's
  // own doc comment already documents why group creation is a ONE-TIME,
  // caller-owned step ("any LATER retry for the same batch ... calls
  // runVisaWorkerLoopForBatch directly -- never this function again, since
  // the group already exists by then"), but before this package
  // /visa_start_submission was the ONLY caller and always went through
  // startVisitSaudiBatchSubmission regardless. On a real retry (e.g. the
  // tunnel dropped mid-batch), the operator's page is no longer on the
  // "Apply for eVisa" dashboard -- clicking APPLY FOR GROUP again would be
  // a genuine navigation guess, exactly what this engagement never does.
  // Detecting "already started" from EXISTING, already-reliable data (no
  // new DB column, no guessed business value): group creation is PROVEN,
  // by this codebase's own flow, to happen strictly before any applicant
  // is ever claimed, so any non-PENDING row for this batch is proof
  // positive the group already exists. AWAITING_MANUAL_CONTINUATION is
  // included in this check for the SAME reason: it means automation
  // already filled this applicant's own Page 3/4 (strictly after group
  // creation), so a batch containing one must never be treated as
  // "never started" -- see visaSubmissionStatus.ts's own doc comment for
  // why AWAITING_MANUAL_CONTINUATION deliberately has no transition back
  // to PENDING, which would otherwise make this exact check blind to it.
  // Computed BEFORE getActiveSession (below) so the correct anchor set --
  // dashboard-only for a fresh run, the broader resumed set otherwise --
  // can be chosen for the ONE session lookup this command ever makes.
  const statusCounts = await deps.countQueueStatuses(batch.id);
  const batchAlreadyStarted =
    statusCounts.SUBMITTING > 0 ||
    statusCounts.SAVED > 0 ||
    statusCounts.ERROR > 0 ||
    statusCounts.AMBIGUOUS > 0 ||
    statusCounts.AWAITING_MANUAL_CONTINUATION > 0;

  const session = await deps.getActiveSession(
    batchAlreadyStarted ? VISITSAUDI_RESUMED_SESSION_ANCHOR_TEXTS : VISITSAUDI_DASHBOARD_ANCHOR_TEXT,
  );
  if (!session.available) {
    return { kind: 'NO_ACTIVE_SESSION', batchName: batch.batchName, reason: session.reason };
  }

  const applicants: VisaWorkerLoopApplicantInput[] = pendingApplicants.map((applicant) => ({
    recordId: applicant.recordId,
    groupId: applicant.groupId,
    passportIdentityId: applicant.passportIdentityId,
  }));

  /**
   * Package 5.46 fix (found while writing this package's own resume test):
   * runVisaWorkerLoopForBatch's "batch completeness" check (visaWorkerLoop.ts,
   * Package 5.0/5.1 hardening) requires the given `applicants` list to match
   * the batch's FULL real active membership exactly, in canonical
   * position_in_batch order -- correct for a FRESH run, where "given list"
   * and "full batch" are the same thing, but wrong for a RESUMED run:
   * `applicants` here is deliberately only the still-PENDING subset
   * (already-SAVED/ERROR/AMBIGUOUS/SUBMITTING applicants are excluded on
   * purpose -- findPendingQueueApplicantsForBatch), so comparing it against
   * the batch's FULL active membership always "fails" with "the list is
   * incomplete" and silently processes NOTHING -- never a thrown error,
   * never surfaced as START_FAILED, just a STARTED outcome whose
   * operatorSummaryText quietly reports the rejection while every
   * remaining PENDING applicant stays untouched. Restricting the real-
   * membership check itself to the SAME already-reliable PENDING set
   * (pendingIdentityIds, straight from the real queue read above) keeps
   * every genuine protection the validation provides intact (a duplicate
   * id, wrong order, or a foreign/inactive identity sneaking into
   * `applicants` is still caught), while correctly allowing the one case
   * that was never actually a bug: a resume naturally omitting applicants
   * that are no longer PENDING. Applied ONLY on the resumed branch below --
   * a FRESH run's own validation stays exactly as strict as before this
   * fix, since there every active applicant IS pending anyway.
   */
  const pendingIdentityIds = new Set(pendingApplicants.map((applicant) => applicant.passportIdentityId));

  const workerDeps: VisaWorkerLoopDependencies = {
    queueStore: deps.buildQueueStore(),
    lockStore: deps.buildLockStore(),
    automation: deps.buildAutomation(session.page),
    checkPreflight: deps.checkPreflight,
    findActiveApplicantPositions: batchAlreadyStarted
      ? async (resumeBatchId) => {
          const realPositions = await deps.findActiveApplicantPositions(resumeBatchId);
          return realPositions.filter((position) => pendingIdentityIds.has(position.passportIdentityId));
        }
      : deps.findActiveApplicantPositions,
  };

  // Package 5.45: the CDP connection this applicant's `session` carries
  // (when it came from getVisitSaudiSessionOverCdp) is always released
  // here, once this run is fully done -- success or failure -- never left
  // open across commands. `release()` disconnects ONLY this connection;
  // per connectToVisitSaudiSessionOverCdp's own doc comment, it never
  // closes the operator's own Chrome, profile, or pre-existing tabs.
  // getNoActiveVisitSaudiSession's own {available:false} branch is
  // already handled above and never reaches this point.
  try {
    if (batchAlreadyStarted) {
      const result = await runVisaWorkerLoopForBatch(batch.id, input.requestedBy, applicants, deps.nowMs(), workerDeps);
      return {
        kind: 'STARTED',
        batchName: batch.batchName,
        operatorSummaryText: buildVisaBatchSubmissionOperatorSummary(batch.batchName, result),
      };
    }
    const result = await startVisitSaudiBatchSubmission(session.page, batch, input.requestedBy, applicants, deps.nowMs(), workerDeps);
    return { kind: 'STARTED', batchName: batch.batchName, operatorSummaryText: result.operatorSummaryText };
  } catch (error) {
    return {
      kind: 'START_FAILED',
      batchName: batch.batchName,
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  } finally {
    await session.release();
  }
}
