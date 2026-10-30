import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import {
  visaContinueApplicantCommand,
  type VisaContinueApplicantCommandDependencies,
} from '../src/visa/visaContinueApplicantCommand.js';
import type { AtomicTransitionOutcome, VisaSubmissionQueueStore } from '../src/visa/visaSubmissionQueueStore.js';
import type { VisaSubmissionStatus } from '../src/visa/visaSubmissionStatus.js';
import type { FlagAmbiguousForReviewOutcome } from '../src/db/repositories/visaSubmissionQueue.repo.js';
import type { VisitSaudiSessionAvailability } from '../src/visa/visitSaudiActiveSession.js';

/**
 * Package [continue-command, now reconnected to the browser session] -- a
 * deliberately DB-FREE unit test for visaContinueApplicantCommand's own
 * status-transition, session-handling, and concurrency-safety logic.
 * Every dependency is a hand-built fake; none of them ever calls the
 * real Postgres pool. The fake queue store below implements the SAME
 * compare-and-swap contract the real Postgres-backed store
 * (visaSubmissionQueuePostgresStore.ts, backed by
 * visaSubmissionQueue.repo.ts's own `UPDATE ... WHERE status = $2`)
 * makes: atomicTransition only succeeds if the record's status is
 * EXACTLY the expected one at the moment of the check, with no await
 * between that check and the mutation -- the same atomicity guarantee
 * this test's own "two concurrent calls" case depends on.
 *
 * The session-dependent tests below use a REAL, LOCAL Playwright page
 * (same hand-built-fixture convention as every other VisitSaudi test in
 * this project) to exercise the real, unmocked isAnchorVisible -- never
 * a real browser connection to the actual VisitSaudi portal.
 */

const FAKE_RECORD_ID = 'fake-queue-record-id';
const FAKE_APPLICANT_ID = 'fake-visa-batch-applicant-id';
const FAKE_GROUP_ID = 'fake-group-id';

function buildFakeQueueStore(initialStatus: VisaSubmissionStatus) {
  let status = initialStatus;
  const claimedAtMsByStatus = () => (status === 'SUBMITTING' ? 1 : null);

  const store: VisaSubmissionQueueStore = {
    createRecord: async () => {
      throw new Error('createRecord must never be called by visaContinueApplicantCommand');
    },
    getRecord: async (recordId) =>
      recordId === FAKE_RECORD_ID
        ? { id: FAKE_RECORD_ID, groupId: FAKE_GROUP_ID, batchId: 'fake-batch-id', passportIdentityId: 'fake-passport-identity-id', status, claimedAtMs: claimedAtMsByStatus() }
        : null,
    findByApplicant: async () => {
      throw new Error('findByApplicant must never be called by visaContinueApplicantCommand');
    },
    atomicTransition: async (recordId, expectedCurrentStatus, nextStatus): Promise<AtomicTransitionOutcome> => {
      // Simulate a real race window (network latency, event-loop
      // scheduling) BEFORE the atomic compare-and-swap itself -- the
      // check-and-mutate below has no `await` in between, exactly
      // mirroring the real store's single `UPDATE ... WHERE status = $2`.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      if (recordId !== FAKE_RECORD_ID) {
        return { outcome: 'record-not-found' };
      }
      if (status !== expectedCurrentStatus) {
        return {
          outcome: 'current-status-mismatch',
          record: { id: FAKE_RECORD_ID, groupId: FAKE_GROUP_ID, batchId: 'fake-batch-id', passportIdentityId: 'fake-passport-identity-id', status, claimedAtMs: claimedAtMsByStatus() },
        };
      }
      status = nextStatus;
      return {
        outcome: 'transitioned',
        record: { id: FAKE_RECORD_ID, groupId: FAKE_GROUP_ID, batchId: 'fake-batch-id', passportIdentityId: 'fake-passport-identity-id', status, claimedAtMs: claimedAtMsByStatus() },
      };
    },
    findStaleSubmitting: async () => [],
  };

  return { store, getStatus: () => status };
}

/** Never actually called in a test using this -- the status check (or NO_QUEUE_RECORD check) must short-circuit first. */
function sessionMustNeverBeAcquired(): (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability> {
  return async () => {
    throw new Error('getActiveSession must never be called when an earlier check already short-circuited');
  };
}

function sessionUnavailable(reason: string): (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability> {
  return async () => ({ available: false, reason });
}

function sessionAvailable(page: Page, releaseCalls: { count: number }): (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability> {
  return async () => ({
    available: true,
    page,
    release: async () => {
      releaseCalls.count += 1;
    },
  });
}

function buildFakeDeps(
  store: VisaSubmissionQueueStore,
  getStatus: () => VisaSubmissionStatus,
  flagCalls: Array<{ queueId: string; detail: string | null }>,
  getActiveSession: (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability>,
  hasQueueRecord = true,
): VisaContinueApplicantCommandDependencies {
  return {
    findGroup: async () => ({
      id: FAKE_GROUP_ID,
      name: 'fake group',
      departureDate: '2026-12-15',
      telegramChatId: '1',
      googleSheetId: null,
      googleSheetGid: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    findApplicantGroupId: async () => FAKE_GROUP_ID,
    findQueueRecordByApplicantId: async () =>
      hasQueueRecord
        ? {
            id: FAKE_RECORD_ID,
            visaBatchApplicantId: FAKE_APPLICANT_ID,
            batchId: 'fake-batch-id',
            groupId: FAKE_GROUP_ID,
            status: getStatus(),
            claimedAt: null,
            conflictDetectedAt: null,
            attempts: 0,
            lastError: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }
        : null,
    flagAmbiguousForReview: async (queueId, detail): Promise<FlagAmbiguousForReviewOutcome> => {
      flagCalls.push({ queueId, detail });
      return 'flagged';
    },
    buildQueueStore: () => store,
    getActiveSession,
    nowMs: () => Date.now(),
  };
}

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  await browser.close();
});

const NON_AWAITING_STATUSES: readonly VisaSubmissionStatus[] = ['PENDING', 'SUBMITTING', 'SAVED', 'ERROR', 'AMBIGUOUS'];

for (const status of NON_AWAITING_STATUSES) {
  test(`visaContinueApplicantCommand: a queue record with status ${status} is rejected as NOT_AWAITING_MANUAL_CONTINUATION BEFORE any session is ever acquired`, async () => {
    const { store, getStatus } = buildFakeQueueStore(status);
    const flagCalls: Array<{ queueId: string; detail: string | null }> = [];
    const deps = buildFakeDeps(store, getStatus, flagCalls, sessionMustNeverBeAcquired());

    const outcome = await visaContinueApplicantCommand(
      { telegramChatId: 1, authorStatus: 'administrator', visaBatchApplicantId: FAKE_APPLICANT_ID },
      deps,
    );

    assert.deepEqual(outcome, { kind: 'NOT_AWAITING_MANUAL_CONTINUATION', currentStatus: status });
    assert.equal(getStatus(), status, 'a rejected call must never change the record\'s own status');
    assert.equal(flagCalls.length, 0, 'flagAmbiguousForReview must never be called for a rejected continuation');
  });
}

test('visaContinueApplicantCommand: no queue record at all for the applicant -> NO_QUEUE_RECORD, never acquires a session, never throws', async () => {
  const { store, getStatus } = buildFakeQueueStore('AWAITING_MANUAL_CONTINUATION');
  const flagCalls: Array<{ queueId: string; detail: string | null }> = [];
  const deps = buildFakeDeps(store, getStatus, flagCalls, sessionMustNeverBeAcquired(), false);

  const outcome = await visaContinueApplicantCommand(
    { telegramChatId: 1, authorStatus: 'administrator', visaBatchApplicantId: FAKE_APPLICANT_ID },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'NO_QUEUE_RECORD' });
});

test('visaContinueApplicantCommand: an AWAITING_MANUAL_CONTINUATION applicant with NO active browser session is NEVER faked as CONTINUED -- reports NO_ACTIVE_SESSION and changes nothing', async () => {
  const { store, getStatus } = buildFakeQueueStore('AWAITING_MANUAL_CONTINUATION');
  const flagCalls: Array<{ queueId: string; detail: string | null }> = [];
  const deps = buildFakeDeps(store, getStatus, flagCalls, sessionUnavailable('VISITSAUDI_CDP_ENDPOINT is not configured'));

  const outcome = await visaContinueApplicantCommand(
    { telegramChatId: 1, authorStatus: 'administrator', visaBatchApplicantId: FAKE_APPLICANT_ID },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'NO_ACTIVE_SESSION', reason: 'VISITSAUDI_CDP_ENDPOINT is not configured' });
  assert.equal(getStatus(), 'AWAITING_MANUAL_CONTINUATION', 'with no session to check anything against, the record must stay exactly as it was');
  assert.equal(flagCalls.length, 0);
});

test('visaContinueApplicantCommand: AWAITING_MANUAL_CONTINUATION + an active session where Page 3\'s own anchor IS observed again -> CONTINUED, record ends AMBIGUOUS (never SAVED), detail records the observation, session is released', async () => {
  await page.setContent('<p>UPLOAD FILE</p>');
  const { store, getStatus } = buildFakeQueueStore('AWAITING_MANUAL_CONTINUATION');
  const flagCalls: Array<{ queueId: string; detail: string | null }> = [];
  const releaseCalls = { count: 0 };
  const deps = buildFakeDeps(store, getStatus, flagCalls, sessionAvailable(page, releaseCalls));

  const outcome = await visaContinueApplicantCommand(
    { telegramChatId: 1, authorStatus: 'administrator', visaBatchApplicantId: FAKE_APPLICANT_ID },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'CONTINUED', nextApplicantPage3Observed: true });
  assert.equal(getStatus(), 'AMBIGUOUS', 'the record must end AMBIGUOUS, never SAVED -- Page 3\'s anchor reappearing is still not an independent save-confirmation signal');
  assert.equal(flagCalls.length, 1);
  assert.equal(flagCalls[0]?.queueId, FAKE_RECORD_ID);
  assert.match(flagCalls[0]?.detail ?? '', /the browser now shows Page 3's own confirmed anchor .* again/);
  assert.equal(releaseCalls.count, 1, 'the acquired session must be released exactly once');
});

test('visaContinueApplicantCommand: AWAITING_MANUAL_CONTINUATION + an active session where Page 3\'s own anchor is NOT observed -> still CONTINUED (never NOT_READY, never blocked), record ends AMBIGUOUS, detail honestly records the anchor was not found', async () => {
  await page.setContent('<p>some unrelated page content</p>');
  const { store, getStatus } = buildFakeQueueStore('AWAITING_MANUAL_CONTINUATION');
  const flagCalls: Array<{ queueId: string; detail: string | null }> = [];
  const releaseCalls = { count: 0 };
  const deps = buildFakeDeps(store, getStatus, flagCalls, sessionAvailable(page, releaseCalls));

  const outcome = await visaContinueApplicantCommand(
    { telegramChatId: 1, authorStatus: 'administrator', visaBatchApplicantId: FAKE_APPLICANT_ID },
    deps,
  );

  assert.deepEqual(outcome, { kind: 'CONTINUED', nextApplicantPage3Observed: false });
  assert.equal(getStatus(), 'AMBIGUOUS');
  assert.match(flagCalls[0]?.detail ?? '', /was NOT observed on the current browser page -- page state is unconfirmed/);
  assert.equal(releaseCalls.count, 1);
});

test('visaContinueApplicantCommand: TWO CONCURRENT calls for the SAME AWAITING_MANUAL_CONTINUATION applicant, both with an active session, never both succeed -- exactly one reaches CONTINUED, the other is safely rejected, never a duplicate submission', async () => {
  await page.setContent('<p>UPLOAD FILE</p>');
  const { store, getStatus } = buildFakeQueueStore('AWAITING_MANUAL_CONTINUATION');
  const flagCallsA: Array<{ queueId: string; detail: string | null }> = [];
  const flagCallsB: Array<{ queueId: string; detail: string | null }> = [];
  const releaseCallsA = { count: 0 };
  const releaseCallsB = { count: 0 };
  const depsA = buildFakeDeps(store, getStatus, flagCallsA, sessionAvailable(page, releaseCallsA));
  const depsB = buildFakeDeps(store, getStatus, flagCallsB, sessionAvailable(page, releaseCallsB));

  const input = { telegramChatId: 1, authorStatus: 'administrator' as const, visaBatchApplicantId: FAKE_APPLICANT_ID };
  const [outcomeA, outcomeB] = await Promise.all([
    visaContinueApplicantCommand(input, depsA),
    visaContinueApplicantCommand(input, depsB),
  ]);

  const outcomes = [outcomeA, outcomeB];
  const continuedCount = outcomes.filter((o) => o.kind === 'CONTINUED').length;
  const rejectedCount = outcomes.filter((o) => o.kind === 'NOT_AWAITING_MANUAL_CONTINUATION').length;

  assert.equal(continuedCount, 1, 'exactly ONE of the two concurrent calls must succeed');
  assert.equal(rejectedCount, 1, 'the OTHER concurrent call must be rejected, never silently ignored and never also succeed');
  assert.equal(getStatus(), 'AMBIGUOUS', 'the record must end in exactly ONE final state, never double-processed');

  const totalFlagCalls = flagCallsA.length + flagCallsB.length;
  assert.equal(totalFlagCalls, 1, 'flagAmbiguousForReview must be called exactly once in total across both concurrent attempts, never twice for the same continuation');

  // BOTH calls acquired a session (both reached the point of checking the
  // anchor before the atomic claim itself decided which one wins), so
  // BOTH must release it -- a lost race must never leak a session.
  assert.equal(releaseCallsA.count, 1);
  assert.equal(releaseCallsB.count, 1);
});
