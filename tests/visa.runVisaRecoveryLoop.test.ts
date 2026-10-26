import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  POLL_INTERVAL_MS,
  runVisaRecoveryLoop,
  type RunVisaRecoveryLoopDependencies,
} from '../src/visa/runVisaRecoveryLoop.js';
import { buildInMemoryVisaBatchLockStore, buildInMemoryVisaSubmissionQueueStore } from '../src/visa/visaSubmissionQueueStore.js';

/**
 * Package 5.17's own loop, exercised entirely through a fully fake
 * RunVisaRecoveryLoopDependencies -- same pattern as
 * tests/sheets.runSheetSyncLoop.test.ts's own pure-fake tests for
 * runSheetSyncLoop. queueStore/lockStore use the already-existing
 * in-memory fakes (visaSubmissionQueueStore.ts) purely for type
 * correctness; recoverSubmitting/recoverLocks are replaced outright, so
 * no test here ever reads or writes anything through them. None of these
 * tests opens a real database connection.
 */
function buildDeps(overrides: Partial<RunVisaRecoveryLoopDependencies> = {}): {
  deps: RunVisaRecoveryLoopDependencies;
  calls: { recoverSubmitting: number; recoverLocks: number; sleep: number };
} {
  const calls = { recoverSubmitting: 0, recoverLocks: 0, sleep: 0 };

  const deps: RunVisaRecoveryLoopDependencies = {
    queueStore: buildInMemoryVisaSubmissionQueueStore(),
    lockStore: buildInMemoryVisaBatchLockStore(),
    recoverSubmitting: async () => {
      calls.recoverSubmitting += 1;
      return { movedToAmbiguous: [], lostRaceAgainstFinish: [], unexpectedFailures: [] };
    },
    recoverLocks: async () => {
      calls.recoverLocks += 1;
      return { released: [], alreadyChanged: [], unexpectedFailures: [] };
    },
    sleep: async () => {
      calls.sleep += 1;
    },
    now: () => Date.now(),
    ...overrides,
  };
  return { deps, calls };
}

test('Package 5.17: runVisaRecoveryLoop calls both recoverSubmitting and recoverLocks every cycle', async () => {
  const { deps, calls } = buildDeps();

  await runVisaRecoveryLoop(() => calls.sleep < 3, deps);

  assert.equal(calls.recoverSubmitting, 3);
  assert.equal(calls.recoverLocks, 3);
  assert.equal(calls.sleep, 3);
});

test('Package 5.17: runVisaRecoveryLoop stops immediately when shouldContinue is already false -- never calls recovery at all', async () => {
  const { deps, calls } = buildDeps();

  await runVisaRecoveryLoop(() => false, deps);

  assert.equal(calls.recoverSubmitting, 0);
  assert.equal(calls.recoverLocks, 0);
  assert.equal(calls.sleep, 0);
});

test('Package 5.17: runVisaRecoveryLoop never overlaps cycles -- the next cycle\'s recoverSubmitting call never starts before the previous cycle\'s sleep has resolved', async () => {
  const events: string[] = [];
  const { deps, calls } = buildDeps({
    recoverSubmitting: async () => {
      events.push('recoverSubmitting:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('recoverSubmitting:end');
      return { movedToAmbiguous: [], lostRaceAgainstFinish: [], unexpectedFailures: [] };
    },
    recoverLocks: async () => {
      events.push('recoverLocks');
      return { released: [], alreadyChanged: [], unexpectedFailures: [] };
    },
    sleep: async () => {
      events.push('sleep');
      calls.sleep += 1;
    },
  });

  await runVisaRecoveryLoop(() => calls.sleep < 2, deps);

  // Exactly the sequential order a single while-loop guarantees -- if two
  // cycles ever overlapped, a second 'recoverSubmitting:start' would
  // appear before the first cycle's 'sleep', which this exact-order
  // assertion would catch.
  assert.deepEqual(events, [
    'recoverSubmitting:start',
    'recoverSubmitting:end',
    'recoverLocks',
    'sleep',
    'recoverSubmitting:start',
    'recoverSubmitting:end',
    'recoverLocks',
    'sleep',
  ]);
});

test('Package 5.17: runVisaRecoveryLoop logs a recoverSubmitting failure safely and still runs recoverLocks the SAME cycle, then continues into future cycles', async () => {
  let submittingAttempts = 0;
  const { deps, calls } = buildDeps({
    recoverSubmitting: async () => {
      submittingAttempts += 1;
      throw new Error('simulated transient DB error');
    },
  });

  await assert.doesNotReject(() => runVisaRecoveryLoop(() => calls.sleep < 2, deps));

  assert.equal(submittingAttempts, 2, 'the loop must still attempt recoverSubmitting on the next cycle after a failure');
  assert.equal(calls.recoverLocks, 2, 'recoverLocks must still run in the SAME cycle as a recoverSubmitting failure, every cycle');
  assert.equal(calls.sleep, 2, 'a failure must never abort the loop -- sleep (and the next cycle) must still happen');
});

test('Package 5.17: runVisaRecoveryLoop logs a recoverLocks failure safely without affecting recoverSubmitting or future cycles', async () => {
  let lockAttempts = 0;
  const { deps, calls } = buildDeps({
    recoverLocks: async () => {
      lockAttempts += 1;
      throw new Error('simulated transient DB error');
    },
  });

  await assert.doesNotReject(() => runVisaRecoveryLoop(() => calls.sleep < 2, deps));

  assert.equal(calls.recoverSubmitting, 2);
  assert.equal(lockAttempts, 2);
  assert.equal(calls.sleep, 2);
});

test('Package 5.17: POLL_INTERVAL_MS is a positive, sane fixed interval', () => {
  assert.ok(POLL_INTERVAL_MS > 0);
  assert.ok(Number.isInteger(POLL_INTERVAL_MS));
});

test(
  'Package 5.19: importing runVisaRecoveryLoop.js never constructs either Postgres store -- only actually CALLING runVisaRecoveryLoop does',
  { skip: typeof mock.module !== 'function' ? 'requires --experimental-test-module-mocks (node:test mock.module unavailable in this run)' : false },
  async () => {
    // mock.module cannot retroactively intercept this test FILE's own
    // earlier static top-of-file import of runVisaRecoveryLoop.js (already
    // cached before this test body runs) -- confirmed empirically during
    // this package's own development via an isolated repro. A fresh,
    // cache-busted dynamic import of the SAME module is required so its
    // own internal `import './visaSubmissionQueuePostgresStore.js'`
    // re-resolves against the mock set up just below, rather than the
    // already-cached real module.
    let submittingBuilds = 0;
    let lockBuilds = 0;
    const storeMock = mock.module('../src/visa/visaSubmissionQueuePostgresStore.js', {
      namedExports: {
        buildPostgresVisaSubmissionQueueStore: () => {
          submittingBuilds += 1;
          return {} as unknown;
        },
        buildPostgresVisaBatchLockStore: () => {
          lockBuilds += 1;
          return {} as unknown;
        },
      },
    });

    try {
      const freshModule = (await import(`../src/visa/runVisaRecoveryLoop.js?package519=${Date.now()}`)) as typeof import('../src/visa/runVisaRecoveryLoop.js');

      assert.equal(submittingBuilds, 0, 'merely importing the module must never construct the submission-queue store');
      assert.equal(lockBuilds, 0, 'merely importing the module must never construct the batch-lock store');

      // Prove the test harness itself is meaningful (not vacuously
      // passing): calling the loop WITHOUT explicit deps -- the exact
      // shape start.ts would use if it ever called this without deps --
      // must still construct both stores exactly once, via the lazy
      // default-parameter mechanism.
      await freshModule.runVisaRecoveryLoop(() => false);
      assert.equal(submittingBuilds, 1, 'calling runVisaRecoveryLoop without explicit deps must construct the submission-queue store exactly once');
      assert.equal(lockBuilds, 1, 'calling runVisaRecoveryLoop without explicit deps must construct the batch-lock store exactly once');
    } finally {
      storeMock.restore();
    }
  },
);
