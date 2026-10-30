import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visaStartSubmissionCommand, type VisaStartSubmissionCommandDependencies } from '../src/visa/visaStartSubmissionCommand.js';
import type { VisaSubmissionStatus } from '../src/visa/visaSubmissionStatus.js';

/**
 * Package 5.?? (status-model phase, step 2) -- a deliberately DB-FREE unit
 * test for the `batchAlreadyStarted` branch inside visaStartSubmissionCommand
 * (never exported as its own function, so this is the only way to exercise
 * it directly). Every dependency is a hand-built fake; none of them ever
 * calls the real Postgres pool. getActiveSession always reports the session
 * as unavailable, so the command returns NO_ACTIVE_SESSION immediately after
 * computing batchAlreadyStarted -- the ONLY thing this test cares about is
 * WHICH anchor-text set was passed into getActiveSession, which proves
 * whether batchAlreadyStarted resolved true or false for the given status
 * counts, without ever touching buildQueueStore/buildLockStore/checkPreflight/
 * buildAutomation (none of which are called before that point).
 *
 * This exists alongside, and does not replace, the real DB-integration
 * coverage in tests/visa.visaStartSubmissionCommand.test.ts (which this
 * phase's own session could not run -- see this phase's own final report).
 */

const ZERO_COUNTS: Record<VisaSubmissionStatus, number> = {
  PENDING: 1,
  SUBMITTING: 0,
  SAVED: 0,
  ERROR: 0,
  AMBIGUOUS: 0,
  AWAITING_MANUAL_CONTINUATION: 0,
};

function buildFakeDeps(
  statusCounts: Record<VisaSubmissionStatus, number>,
  onGetActiveSession: (anchorTexts: string | readonly string[]) => void,
): VisaStartSubmissionCommandDependencies {
  return {
    findGroup: async () => ({
      id: 'fake-group-id',
      name: 'fake group',
      departureDate: '2026-12-15',
      telegramChatId: '123',
      googleSheetId: null,
      googleSheetGid: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    findLastBatch: async () => ({
      id: 'fake-batch-id',
      groupId: 'fake-group-id',
      portal: 'visitsaudi',
      batchNumber: 1,
      batchName: 'fake-batch-name',
      status: 'submitted',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    findPendingQueueApplicants: async () => [
      { recordId: 'fake-queue-row-id', groupId: 'fake-group-id', passportIdentityId: 'fake-passport-id', positionInBatch: 1 },
    ],
    findActiveApplicantPositions: async () => {
      throw new Error('findActiveApplicantPositions must never be called before getActiveSession reports unavailable');
    },
    countQueueStatuses: async () => statusCounts,
    buildQueueStore: () => {
      throw new Error('buildQueueStore must never be called before getActiveSession reports unavailable');
    },
    buildLockStore: () => {
      throw new Error('buildLockStore must never be called before getActiveSession reports unavailable');
    },
    checkPreflight: async () => {
      throw new Error('checkPreflight must never be called before getActiveSession reports unavailable');
    },
    buildAutomation: () => {
      throw new Error('buildAutomation must never be called before getActiveSession reports unavailable');
    },
    getActiveSession: async (anchorTexts) => {
      onGetActiveSession(anchorTexts);
      return { available: false, reason: 'fake: no session for this DB-free unit test' };
    },
    nowMs: () => Date.now(),
  };
}

test('batchAlreadyStarted: an all-PENDING batch is treated as FRESH -- getActiveSession receives the dashboard-only anchor', async () => {
  let received: string | readonly string[] | undefined;
  const deps = buildFakeDeps(ZERO_COUNTS, (anchorTexts) => {
    received = anchorTexts;
  });

  const outcome = await visaStartSubmissionCommand(
    { telegramChatId: 1, authorStatus: 'administrator', requestedBy: 'operator:test' },
    deps,
  );

  assert.equal(outcome.kind, 'NO_ACTIVE_SESSION');
  assert.equal(typeof received, 'string', 'a FRESH batch must receive the single dashboard anchor string, not the resumed-session array');
  assert.equal(received, 'APPLY FOR GROUP');
});

const RESUMING_CASES: ReadonlyArray<[string, Partial<Record<VisaSubmissionStatus, number>>]> = [
  ['SUBMITTING', { SUBMITTING: 1 }],
  ['SAVED', { SAVED: 1 }],
  ['ERROR', { ERROR: 1 }],
  ['AMBIGUOUS', { AMBIGUOUS: 1 }],
  ['AWAITING_MANUAL_CONTINUATION', { AWAITING_MANUAL_CONTINUATION: 1 }],
];

for (const [label, overrides] of RESUMING_CASES) {
  test(`batchAlreadyStarted: a batch with one ${label} row is treated as RESUMED -- getActiveSession receives the resumed-session anchor set`, async () => {
    let received: string | readonly string[] | undefined;
    const counts: Record<VisaSubmissionStatus, number> = { ...ZERO_COUNTS, PENDING: 1, ...overrides };
    const deps = buildFakeDeps(counts, (anchorTexts) => {
      received = anchorTexts;
    });

    const outcome = await visaStartSubmissionCommand(
      { telegramChatId: 1, authorStatus: 'administrator', requestedBy: 'operator:test' },
      deps,
    );

    assert.equal(outcome.kind, 'NO_ACTIVE_SESSION');
    assert.ok(Array.isArray(received), `a RESUMED batch (${label}) must receive the resumed-session anchor array, not the single dashboard string`);
    assert.ok((received as readonly string[]).length > 1, 'the resumed-session anchor set must offer more than one candidate page');
  });
}

test('batchAlreadyStarted: AWAITING_MANUAL_CONTINUATION alone (no SUBMITTING/SAVED/ERROR/AMBIGUOUS) is still enough to mark the batch RESUMED -- this is the exact regression this phase guards against', async () => {
  let received: string | readonly string[] | undefined;
  const counts: Record<VisaSubmissionStatus, number> = { ...ZERO_COUNTS, PENDING: 1, AWAITING_MANUAL_CONTINUATION: 1 };
  const deps = buildFakeDeps(counts, (anchorTexts) => {
    received = anchorTexts;
  });

  await visaStartSubmissionCommand({ telegramChatId: 1, authorStatus: 'administrator', requestedBy: 'operator:test' }, deps);

  assert.ok(Array.isArray(received), 'a lone AWAITING_MANUAL_CONTINUATION row must still select the resumed-session anchor set, never the dashboard-only one -- group creation must never be re-attempted for this batch');
});
