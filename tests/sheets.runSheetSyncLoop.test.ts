import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  RECONCILE_INTERVAL_MINUTES,
  reconcileStaleSyncingJobs,
  runSheetSyncLoop,
  type RunSheetSyncLoopDependencies,
} from '../src/sheets/runSheetSyncLoop.js';
import { syncPassportRowToSheet, type SyncPassportRowToSheetDependencies } from '../src/sheets/syncPassportRowToSheet.js';
import {
  enqueueSheetSync,
  findDueSheetSyncJobs,
  markSheetSyncStarted,
  recoverStaleSyncingJobs,
  type SheetSyncQueueRecord,
  type StaleSheetSyncRecoveryResult,
} from '../src/db/repositories/sheetSyncQueue.repo.js';
import * as sheetSyncQueueRepo from '../src/db/repositories/sheetSyncQueue.repo.js';

const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MINUTES * 60_000;

const SAMPLE_JOB: SheetSyncQueueRecord = {
  id: 'job-1',
  telegramMessageId: 'msg-1',
  status: 'pending',
  attempts: 0,
  lastError: null,
  sheetRowNumber: null,
  nextAttemptAt: '2026-01-01T00:00:00.000Z',
  syncedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function buildDeps(overrides: Partial<RunSheetSyncLoopDependencies> = {}): {
  deps: RunSheetSyncLoopDependencies;
  calls: { findDue: number; processJob: number; sleep: number; reconcile: number };
  processedIds: string[];
} {
  const calls = { findDue: 0, processJob: 0, sleep: 0, reconcile: 0 };
  const processedIds: string[] = [];

  const deps: RunSheetSyncLoopDependencies = {
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

test('runSheetSyncLoop processes every due job returned by findDue', async () => {
  // findDue supplies jobs on its first call only, then empty — a real
  // findDue() call happens on every loop iteration regardless of branch,
  // so counting THAT (not sleep, which is skipped whenever jobs were
  // found) is what reliably terminates this test after exactly one batch.
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

  await runSheetSyncLoop(() => calls.findDue < 2, deps);

  assert.equal(calls.processJob, 2);
  assert.deepEqual(processedIds, ['job-1', 'job-2']);
});

test('runSheetSyncLoop does no DB/Sheets work at all while disabled — only sleeps', async () => {
  let iterations = 0;
  const { deps, calls } = buildDeps({
    isEnabled: () => false,
    sleep: async () => {
      calls.sleep += 1;
      iterations += 1;
    },
  });

  await runSheetSyncLoop(() => iterations < 3, deps);

  assert.equal(calls.findDue, 0);
  assert.equal(calls.processJob, 0);
  assert.equal(calls.sleep, 3);
});

test('runSheetSyncLoop keeps going after one job throws unexpectedly (last-resort guard, mirrors runWorkerLoop)', async () => {
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

  await runSheetSyncLoop(() => calls.findDue < 2, deps);

  assert.deepEqual(processedIds, ['job-bad', 'job-good'], 'job-good must still be attempted after job-bad throws');
});

test('runSheetSyncLoop stops between jobs promptly once shouldContinue flips mid-batch', async () => {
  const processedIds: string[] = [];
  let stop = false;
  const deps: RunSheetSyncLoopDependencies = {
    findDue: async () => [
      { ...SAMPLE_JOB, id: 'job-1' },
      { ...SAMPLE_JOB, id: 'job-2' },
      { ...SAMPLE_JOB, id: 'job-3' },
    ],
    processJob: async (id) => {
      processedIds.push(id);
      if (id === 'job-1') stop = true; // simulate a shutdown signal arriving mid-batch
    },
    reconcile: async () => {},
    isEnabled: () => true,
    sleep: async () => {},
    now: () => Date.now(),
  };

  await runSheetSyncLoop(() => !stop, deps);

  assert.deepEqual(processedIds, ['job-1'], 'must not start job-2/job-3 once shouldContinue has flipped false');
});

test('runSheetSyncLoop lets a findDue failure propagate (fatal/systemic, matches runWorkerLoop policy)', async () => {
  const { deps } = buildDeps({
    findDue: async () => {
      throw new Error('connection to postgres lost');
    },
  });

  await assert.rejects(() => runSheetSyncLoop(() => true, deps), /connection to postgres lost/);
});

// --- reconcileStaleSyncingJobs (called at startup by start.ts, and periodically below) ---

function staleResult(overrides: Partial<StaleSheetSyncRecoveryResult> = {}): StaleSheetSyncRecoveryResult {
  return { requeued: [], failed: [], ...overrides };
}

test('reconcileStaleSyncingJobs calls the injected recover function', async () => {
  let calls = 0;
  await reconcileStaleSyncingJobs({
    recover: async () => {
      calls += 1;
      return staleResult();
    },
  });

  assert.equal(calls, 1);
});

test('reconcileStaleSyncingJobs logs a summary when something was actually recovered or given up', async () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await reconcileStaleSyncingJobs({
      recover: async () => staleResult({ requeued: [{ ...SAMPLE_JOB, id: 'r1' }], failed: [{ ...SAMPLE_JOB, id: 'f1' }] }),
    });
  } finally {
    console.log = originalLog;
  }

  const combined = logged.join('\n');
  assert.match(combined, /requeued=1/);
  assert.match(combined, /gave-up=1/);
});

test('reconcileStaleSyncingJobs logs nothing when there was nothing to recover (quiet on the common case)', async () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await reconcileStaleSyncingJobs({ recover: async () => staleResult() });
  } finally {
    console.log = originalLog;
  }

  assert.equal(logged.length, 0);
});

test('reconcileStaleSyncingJobs propagates a recovery failure (fatal/systemic — startup call in start.ts must be allowed to crash the process)', async () => {
  await assert.rejects(
    () => reconcileStaleSyncingJobs({ recover: async () => { throw new Error('connection to postgres lost'); } }),
    /connection to postgres lost/,
  );
});

// --- runSheetSyncLoop's periodic reconciliation tick (mirrors tests/worker.runWorkerLoop.test.ts) ---

function buildClock() {
  let currentTime = 0;
  return {
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

test('runSheetSyncLoop does not call reconcile before RECONCILE_INTERVAL_MINUTES has elapsed', async () => {
  const clock = buildClock();
  let reconcileCalls = 0;
  let iterations = 0;
  const maxIterations = 3; // 3 * POLL_INTERVAL-equivalent advance, staying comfortably under the interval

  const { deps } = buildDeps({
    reconcile: async () => {
      reconcileCalls += 1;
    },
    isEnabled: () => false, // simplest path: every iteration just sleeps
    sleep: async () => {
      iterations += 1;
      clock.advance(60_000); // 1 minute per iteration; 3 iterations = 3 minutes, well under the 5-minute interval
    },
    now: clock.now,
  });

  await runSheetSyncLoop(() => iterations < maxIterations, deps);

  assert.equal(reconcileCalls, 0, 'reconcile must not run before RECONCILE_INTERVAL_MINUTES has elapsed');
});

test('runSheetSyncLoop calls reconcile exactly once after RECONCILE_INTERVAL_MINUTES elapses, then resets the timer', async () => {
  const clock = buildClock();
  let reconcileCalls = 0;
  let iterations = 0;
  // Advance past the interval on the very first sleep, then stay flat — so
  // a second reconcile call here would indicate the timer never reset.
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

  await runSheetSyncLoop(() => iterations < maxIterations, deps);

  assert.equal(reconcileCalls, 1, 'reconcile must fire exactly once once the interval has elapsed, not repeatedly');
});

test('runSheetSyncLoop lets a reconcile failure propagate (fatal/systemic, matches runWorkerLoop policy)', async () => {
  // lastReconcileAt is captured via deps.now() at the very start of
  // runSheetSyncLoop, so a clock pre-advanced beforehand has no effect —
  // the first diff is always 0 against itself. Instead, return 0 on the
  // first now() call (captured as lastReconcileAt) and an
  // already-elapsed value on the very next call (the interval check on
  // that same first loop iteration), guaranteeing reconcile fires before
  // anything else (findDue/sleep) is ever reached.
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

  await assert.rejects(() => runSheetSyncLoop(() => true, deps), /connection to postgres lost/);
});

// --- Concurrency: two workers racing the same real DB row -----------------

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniqueUserId(): number {
  idCounter += 1;
  return Date.now() * 1000 + idCounter;
}
function uniqueMessageId(): number {
  idCounter += 1;
  return idCounter;
}

interface Fixture {
  telegramMessageId: string;
  chatId: number;
}

async function createLinkedTelegramMessage(): Promise<Fixture> {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();

  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Sheets Loop Test Group', '2026-09-20', chatId],
  );
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Sheets Loop Test Agent', senderId],
  );
  assert.ok(group);
  assert.ok(agent);

  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Sheets Loop Test Sender', now(), 'FILE_SHEETS_LOOP_TEST', $4, $5)
     RETURNING id`,
    [chatId, uniqueMessageId(), senderId, group.id, agent.id],
  );
  assert.ok(message);

  return { telegramMessageId: message.id, chatId };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await pool.query('DELETE FROM telegram_messages WHERE telegram_chat_id = $1', [fixture.chatId]);
}

async function backdateUpdatedAtMinutes(id: string, minutesAgo: number): Promise<void> {
  // Same trigger-bypass technique as tests/sheetSyncQueue.repo.test.ts: the
  // set_updated_at trigger unconditionally overwrites updated_at to now()
  // on every UPDATE, so a plain UPDATE cannot backdate it. session_replication_role
  // = replica, scoped to this one transaction via SET LOCAL, suppresses
  // that trigger just long enough to simulate a "stale" row.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`UPDATE sheet_sync_queue SET updated_at = now() - ($2 * interval '1 minute') WHERE id = $1`, [
      id,
      minutesAgo,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('a stale syncing job, once recovered, is picked up again by findDueSheetSyncJobs (the actual thing runSheetSyncLoop polls)', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    const claimed = await markSheetSyncStarted(job.id); // pending -> syncing, simulating a worker that then crashed
    assert.ok(claimed);
    assert.equal(claimed.status, 'syncing');

    let due = await findDueSheetSyncJobs(50);
    assert.ok(!due.some((row) => row.id === job.id), 'a syncing job must not be due yet — it is presumed still in progress');

    await backdateUpdatedAtMinutes(job.id, sheetSyncQueueRepo.STALE_SYNCING_TIMEOUT_MINUTES + 1);

    const { requeued } = await recoverStaleSyncingJobs();
    assert.ok(requeued.some((row) => row.id === job.id));

    due = await findDueSheetSyncJobs(50);
    assert.ok(due.some((row) => row.id === job.id), 'once recovered, the exact same job the real poll loop uses must find it again');
  } finally {
    await cleanup(fixture);
  }
});

test('two concurrent syncPassportRowToSheet calls for the same real queue row can never both win the claim', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    let upsertCalls = 0;
    const fakeDeps: SyncPassportRowToSheetDependencies = {
      markStarted: sheetSyncQueueRepo.markSheetSyncStarted, // real DB claim — the actual thing under test
      markSynced: sheetSyncQueueRepo.markSheetSyncSynced,
      markFailed: sheetSyncQueueRepo.markSheetSyncFailed,
      findTelegramMessage: async () => ({
        id: fixture.telegramMessageId,
        telegramChatId: String(fixture.chatId),
        telegramMessageId: '1',
        telegramSenderUserId: '1',
        telegramSenderDisplayName: null,
        messageTimestamp: new Date().toISOString(),
        telegramPhotoFileId: 'FILE',
        source: 'photo',
        groupId: 'irrelevant-not-used-because-ensureSheet-is-faked',
        agentId: null,
        createdAt: new Date().toISOString(),
      }),
      findOcrResult: async () => ({
        id: 'ocr-1',
        telegramMessageId: fixture.telegramMessageId,
        firstName: { value: 'ANNA', confidence: 'high' },
        middleName: { value: null, confidence: null },
        surname: { value: 'ERIKSSON', confidence: 'high' },
        passportNumber: { value: 'L898902C3', confidence: 'high' },
        dateOfBirth: { value: '1974-08-12', confidence: 'high' },
        passportIssueDate: { value: null, confidence: null },
        passportExpiryDate: { value: '2012-04-15', confidence: 'high' },
        gender: { value: 'female', confidence: 'high' },
        nationality: { value: 'UTO', confidence: 'high' },
        placeOfBirth: { value: null, confidence: null },
        issuingAuthority: { value: null, confidence: null },
        mrz: { value: null, confidence: null },
        overallConfidence: 'high',
        rawResponse: {},
        provider: 'google-vision',
        model: 'google-vision-mrz',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      findAgent: async () => null,
      ensureSheet: async () => ({ spreadsheetId: 'fake-sheet-id' }),
      upsertRow: async () => {
        upsertCalls += 1;
        return { action: 'appended', rowNumber: 2 };
      },
      now: () => new Date(),
    };

    // Two "workers" racing the exact same real queue row concurrently.
    await Promise.all([syncPassportRowToSheet(job.id, fakeDeps), syncPassportRowToSheet(job.id, fakeDeps)]);

    assert.equal(upsertCalls, 1, 'only the worker that actually won the DB claim may ever reach the Sheets write');
  } finally {
    await cleanup(fixture);
  }
});

after(async () => {
  await pool.end();
});
