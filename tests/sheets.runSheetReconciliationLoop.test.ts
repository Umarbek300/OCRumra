import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SheetReconciliationJobRecord, StaleReconciliationRecoveryResult } from '../src/db/repositories/sheetReconciliation.repo.js';
import {
  RECONCILE_INTERVAL_MINUTES,
  reconcileStaleReconciliationJobs,
  runSheetReconciliationLoop,
  type RunSheetReconciliationLoopDependencies,
} from '../src/sheets/runSheetReconciliationLoop.js';

const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MINUTES * 60_000;

const SAMPLE_JOB: SheetReconciliationJobRecord = {
  id: 'job-1',
  passportIdentityId: 'identity-1',
  groupId: 'group-1',
  expectedOldCanonicalTelegramMessageId: 'msg-1',
  sourceOperation: 'cancel_passport',
  sourceEventId: null,
  status: 'pending',
  attempts: 0,
  lastError: null,
  nextAttemptAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
};

function buildDeps(overrides: Partial<RunSheetReconciliationLoopDependencies> = {}): {
  deps: RunSheetReconciliationLoopDependencies;
  calls: { findDue: number; processJob: number; sleep: number; reconcile: number };
  processedIds: string[];
} {
  const calls = { findDue: 0, processJob: 0, sleep: 0, reconcile: 0 };
  const processedIds: string[] = [];

  const deps: RunSheetReconciliationLoopDependencies = {
    findDue: async () => {
      calls.findDue += 1;
      return [];
    },
    processJob: async (id) => {
      calls.processJob += 1;
      processedIds.push(id);
    },
    reconcile: async () => {
      calls.reconcile += 1;
    },
    isEnabled: () => true,
    sleep: async () => {
      calls.sleep += 1;
    },
    now: () => Date.now(),
    ...overrides,
  };
  return { deps, calls, processedIds };
}

test('runSheetReconciliationLoop processes every due job returned by findDue', async () => {
  const { deps, calls, processedIds } = buildDeps({
    findDue: async () => {
      calls.findDue += 1;
      if (calls.findDue > 1) return [];
      return [
        { ...SAMPLE_JOB, id: 'job-1' },
        { ...SAMPLE_JOB, id: 'job-2' },
      ];
    },
  });

  await runSheetReconciliationLoop(() => calls.findDue < 2, deps);

  assert.equal(calls.processJob, 2);
  assert.deepEqual(processedIds, ['job-1', 'job-2']);
});

test('runSheetReconciliationLoop does no DB/Sheets work at all while disabled -- only sleeps', async () => {
  let iterations = 0;
  const { deps, calls } = buildDeps({
    isEnabled: () => false,
    sleep: async () => {
      calls.sleep += 1;
      iterations += 1;
    },
  });

  await runSheetReconciliationLoop(() => iterations < 3, deps);

  assert.equal(calls.findDue, 0);
  assert.equal(calls.processJob, 0);
  assert.equal(calls.sleep, 3);
});

test('runSheetReconciliationLoop keeps going after one job throws unexpectedly (last-resort guard)', async () => {
  const { deps, calls, processedIds } = buildDeps({
    findDue: async () => {
      calls.findDue += 1;
      if (calls.findDue > 1) return [];
      return [
        { ...SAMPLE_JOB, id: 'job-bad' },
        { ...SAMPLE_JOB, id: 'job-good' },
      ];
    },
    processJob: async (id) => {
      processedIds.push(id);
      if (id === 'job-bad') throw new Error('unexpected bug');
    },
  });

  await runSheetReconciliationLoop(() => calls.findDue < 2, deps);

  assert.deepEqual(processedIds, ['job-bad', 'job-good'], 'job-good must still be attempted after job-bad throws');
});

test('runSheetReconciliationLoop stops between jobs promptly once shouldContinue flips mid-batch', async () => {
  const processedIds: string[] = [];
  let stop = false;
  const deps: RunSheetReconciliationLoopDependencies = {
    findDue: async () => [
      { ...SAMPLE_JOB, id: 'job-1' },
      { ...SAMPLE_JOB, id: 'job-2' },
      { ...SAMPLE_JOB, id: 'job-3' },
    ],
    processJob: async (id) => {
      processedIds.push(id);
      if (id === 'job-1') stop = true;
    },
    reconcile: async () => {},
    isEnabled: () => true,
    sleep: async () => {},
    now: () => Date.now(),
  };

  await runSheetReconciliationLoop(() => !stop, deps);

  assert.deepEqual(processedIds, ['job-1'], 'must not start job-2/job-3 once shouldContinue has flipped false');
});

test('runSheetReconciliationLoop lets a findDue failure propagate (fatal/systemic)', async () => {
  const { deps } = buildDeps({
    findDue: async () => {
      throw new Error('connection to postgres lost');
    },
  });

  await assert.rejects(() => runSheetReconciliationLoop(() => true, deps), /connection to postgres lost/);
});

function staleResult(overrides: Partial<StaleReconciliationRecoveryResult> = {}): StaleReconciliationRecoveryResult {
  return { requeued: [], failed: [], ...overrides };
}

test('reconcileStaleReconciliationJobs calls the injected recover function', async () => {
  let calls = 0;
  await reconcileStaleReconciliationJobs({
    recover: async () => {
      calls += 1;
      return staleResult();
    },
  });

  assert.equal(calls, 1);
});

test('reconcileStaleReconciliationJobs logs a summary when something was actually recovered or given up', async () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await reconcileStaleReconciliationJobs({
      recover: async () => staleResult({ requeued: [{ ...SAMPLE_JOB, id: 'r1' }], failed: [{ ...SAMPLE_JOB, id: 'f1' }] }),
    });
  } finally {
    console.log = originalLog;
  }

  const combined = logged.join('\n');
  assert.match(combined, /requeued=1/);
  assert.match(combined, /gave-up=1/);
});

test('reconcileStaleReconciliationJobs logs nothing when there was nothing to recover', async () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await reconcileStaleReconciliationJobs({ recover: async () => staleResult() });
  } finally {
    console.log = originalLog;
  }

  assert.equal(logged.length, 0);
});

test('reconcileStaleReconciliationJobs propagates a recovery failure (fatal/systemic)', async () => {
  await assert.rejects(
    () => reconcileStaleReconciliationJobs({ recover: async () => { throw new Error('connection to postgres lost'); } }),
    /connection to postgres lost/,
  );
});

function buildClock() {
  let currentTime = 0;
  return {
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

test('runSheetReconciliationLoop does not call reconcile before RECONCILE_INTERVAL_MINUTES has elapsed', async () => {
  const clock = buildClock();
  let reconcileCalls = 0;
  let iterations = 0;
  const maxIterations = 3;

  const { deps } = buildDeps({
    reconcile: async () => {
      reconcileCalls += 1;
    },
    isEnabled: () => false,
    sleep: async () => {
      iterations += 1;
      clock.advance(60_000);
    },
    now: clock.now,
  });

  await runSheetReconciliationLoop(() => iterations < maxIterations, deps);

  assert.equal(reconcileCalls, 0, 'reconcile must not run before RECONCILE_INTERVAL_MINUTES has elapsed');
});

test('runSheetReconciliationLoop calls reconcile exactly once after RECONCILE_INTERVAL_MINUTES elapses, then resets the timer', async () => {
  const clock = buildClock();
  let reconcileCalls = 0;
  let iterations = 0;
  const maxIterations = 3;

  const { deps } = buildDeps({
    reconcile: async () => {
      reconcileCalls += 1;
    },
    isEnabled: () => false,
    sleep: async () => {
      iterations += 1;
      if (iterations === 1) clock.advance(RECONCILE_INTERVAL_MS + 1);
    },
    now: clock.now,
  });

  await runSheetReconciliationLoop(() => iterations < maxIterations, deps);

  assert.equal(reconcileCalls, 1, 'reconcile must fire exactly once once the interval has elapsed, not repeatedly');
});

test('runSheetReconciliationLoop lets a reconcile failure propagate (fatal/systemic)', async () => {
  let nowCalls = 0;
  const now = () => {
    nowCalls += 1;
    return nowCalls === 1 ? 0 : RECONCILE_INTERVAL_MS + 1;
  };

  const { deps } = buildDeps({
    reconcile: async () => {
      throw new Error('connection to postgres lost');
    },
    now,
  });

  await assert.rejects(() => runSheetReconciliationLoop(() => true, deps), /connection to postgres lost/);
});
