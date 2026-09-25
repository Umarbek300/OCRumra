import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECONCILE_INTERVAL_MINUTES, runWorkerLoop } from '../src/worker/passportWorker.js';

/**
 * Pure unit tests for runWorkerLoop's periodic reconciliation tick -- no
 * real Redis/Postgres involved. Every dependency (dequeue, processJob,
 * reconcile, the clock) is injected, so timing is deterministic: a fake
 * clock advances a fixed 5000ms (matching the real POLL_TIMEOUT_SECONDS
 * BRPOP timeout) on every simulated dequeue call, standing in for one real
 * poll-loop heartbeat.
 */

const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MINUTES * 60_000;
const HEARTBEAT_MS = 5000;

function buildClock() {
  let currentTime = 0;
  return {
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

test('runWorkerLoop does not call reconcile before the interval has elapsed', async () => {
  const clock = buildClock();
  let reconcileCalls = 0;
  const reconcile = async () => {
    reconcileCalls += 1;
  };

  let iterations = 0;
  // Stay comfortably under the interval: iterations * HEARTBEAT_MS < RECONCILE_INTERVAL_MS.
  const maxIterations = Math.floor(RECONCILE_INTERVAL_MS / HEARTBEAT_MS) - 1;
  const dequeue = async () => {
    iterations += 1;
    clock.advance(HEARTBEAT_MS);
    return null;
  };

  await runWorkerLoop(() => iterations < maxIterations, {
    dequeue,
    processJob: async () => {},
    reconcile,
    now: clock.now,
  });

  assert.equal(reconcileCalls, 0, 'reconcile must not run before RECONCILE_INTERVAL_MINUTES has elapsed');
});

test('runWorkerLoop calls reconcile exactly once after the interval elapses, then resets the timer', async () => {
  const clock = buildClock();
  let reconcileCalls = 0;
  const reconcile = async () => {
    reconcileCalls += 1;
  };

  let iterations = 0;
  // Enough iterations to cross the interval once, but not twice.
  const iterationsToCross = Math.ceil(RECONCILE_INTERVAL_MS / HEARTBEAT_MS) + 1;
  const maxIterations = iterationsToCross + 5;
  const dequeue = async () => {
    iterations += 1;
    clock.advance(HEARTBEAT_MS);
    return null;
  };

  await runWorkerLoop(() => iterations < maxIterations, {
    dequeue,
    processJob: async () => {},
    reconcile,
    now: clock.now,
  });

  assert.equal(reconcileCalls, 1, 'reconcile must fire exactly once for a single interval crossing, then wait for the next one');
});

test('runWorkerLoop keeps processing normal jobs via processJob, both before and after a reconciliation tick', async () => {
  const clock = buildClock();
  const reconcile = async () => {};
  const processedIds: string[] = [];
  const processJob = async (telegramMessageId: string) => {
    processedIds.push(telegramMessageId);
  };

  let iterations = 0;
  const iterationsToCross = Math.ceil(RECONCILE_INTERVAL_MS / HEARTBEAT_MS) + 1;
  const maxIterations = iterationsToCross + 3;
  const dequeue = async () => {
    iterations += 1;
    clock.advance(HEARTBEAT_MS);
    if (iterations === 1) return { telegramMessageId: 'job-before-tick', queuedAt: new Date().toISOString() };
    if (iterations === iterationsToCross + 1) {
      return { telegramMessageId: 'job-after-tick', queuedAt: new Date().toISOString() };
    }
    return null;
  };

  await runWorkerLoop(() => iterations < maxIterations, {
    dequeue,
    processJob,
    reconcile,
    now: clock.now,
  });

  assert.deepEqual(
    processedIds,
    ['job-before-tick', 'job-after-tick'],
    'normal Redis polling/processing must be unaffected by the reconciliation tick',
  );
});

test('a reconciliation failure propagates out of runWorkerLoop, matching the existing dequeue-failure policy (never silently swallowed)', async () => {
  const clock = buildClock();
  const reconcile = async () => {
    throw new Error('simulated DB outage during reconciliation');
  };
  const dequeue = async () => {
    clock.advance(HEARTBEAT_MS);
    return null;
  };

  // shouldContinue is always true -- if the failure were ever caught and
  // swallowed inside the loop, this would spin forever instead of
  // resolving/rejecting. The interval crossing forces reconcile to run.
  await assert.rejects(
    () =>
      runWorkerLoop(() => true, {
        dequeue,
        processJob: async () => {},
        reconcile,
        now: clock.now,
      }),
    /simulated DB outage during reconciliation/,
  );
});

test('runWorkerLoop with shouldContinue already false resolves immediately, calling neither dequeue nor reconcile -- no separate timer exists to clean up on shutdown', async () => {
  let dequeueCalls = 0;
  let reconcileCalls = 0;
  const dequeue = async () => {
    dequeueCalls += 1;
    return null;
  };
  const reconcile = async () => {
    reconcileCalls += 1;
  };

  await runWorkerLoop(() => false, {
    dequeue,
    processJob: async () => {},
    reconcile,
    now: () => 0,
  });

  assert.equal(dequeueCalls, 0);
  assert.equal(reconcileCalls, 0);
});
