import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  enqueueSheetSync,
  findDueSheetSyncJobs,
  findSheetSyncQueueByTelegramMessageId,
  markSheetSyncFailed,
  markSheetSyncStarted,
  markSheetSyncSynced,
  MAX_SHEET_SYNC_ATTEMPTS,
  recoverStaleSyncingJobs,
} from '../src/db/repositories/sheetSyncQueue.repo.js';

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
  groupId: string;
  agentId: string;
  chatId: number;
}

async function createLinkedTelegramMessage(): Promise<Fixture> {
  const chatId = uniqueChatId();
  const senderId = uniqueUserId();

  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Sheet Sync Test Group', '2026-09-20', chatId],
  );
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Sheet Sync Test Agent', senderId],
  );
  assert.ok(group);
  assert.ok(agent);

  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Sheet Sync Test Sender', now(), 'FILE_SHEET_SYNC_TEST', $4, $5)
     RETURNING id`,
    [chatId, uniqueMessageId(), senderId, group.id, agent.id],
  );
  assert.ok(message);

  return { telegramMessageId: message.id, groupId: group.id, agentId: agent.id, chatId };
}

async function cleanup(fixture: Fixture): Promise<void> {
  // ON DELETE CASCADE from telegram_messages cleans up the sheet_sync_queue row too.
  await pool.query('DELETE FROM telegram_messages WHERE telegram_chat_id = $1', [fixture.chatId]);
  await pool.query('DELETE FROM groups WHERE id = $1', [fixture.groupId]);
  await pool.query('DELETE FROM agents WHERE id = $1', [fixture.agentId]);
}

async function backdateNextAttemptAt(id: string, minutesFromNow: number): Promise<void> {
  await pool.query(`UPDATE sheet_sync_queue SET next_attempt_at = now() + ($2 * interval '1 minute') WHERE id = $1`, [
    id,
    minutesFromNow,
  ]);
}

async function backdateUpdatedAtMinutes(id: string, minutesAgo: number): Promise<void> {
  // updated_at is normally maintained by the set_updated_at trigger, which
  // unconditionally overwrites it to now() on every UPDATE — including a
  // naive attempt to backdate it. session_replication_role=replica (scoped
  // to this one transaction via SET LOCAL) suppresses that trigger just
  // long enough to simulate a "stale" row for the recovery tests below;
  // it never touches the schema or affects any other connection.
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

test('enqueueSheetSync creates a new pending job for a linked telegram_message', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);

    assert.ok(job);
    assert.equal(job.telegramMessageId, fixture.telegramMessageId);
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.equal(job.lastError, null);
    assert.equal(job.sheetRowNumber, null);
    assert.equal(job.syncedAt, null);
  } finally {
    await cleanup(fixture);
  }
});

test('enqueueSheetSync is idempotent — a second call for the same message returns null and creates no duplicate row', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const first = await enqueueSheetSync(fixture.telegramMessageId);
    const second = await enqueueSheetSync(fixture.telegramMessageId);

    assert.ok(first);
    assert.equal(second, null, 'ON CONFLICT DO NOTHING — no row is returned for the duplicate attempt');

    const { rows } = await pool.query('SELECT id FROM sheet_sync_queue WHERE telegram_message_id = $1', [
      fixture.telegramMessageId,
    ]);
    assert.equal(rows.length, 1, 'exactly one queue row must exist, never a duplicate');
  } finally {
    await cleanup(fixture);
  }
});

test('findDueSheetSyncJobs returns a pending job whose next_attempt_at has already arrived', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    const due = await findDueSheetSyncJobs(50);
    assert.ok(due.some((row) => row.id === job.id));
  } finally {
    await cleanup(fixture);
  }
});

test('findDueSheetSyncJobs excludes a job whose next_attempt_at is scheduled in the future', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    await backdateNextAttemptAt(job.id, 30); // 30 minutes from now

    const due = await findDueSheetSyncJobs(50);
    assert.ok(!due.some((row) => row.id === job.id), 'a not-yet-due job must not be selected');
  } finally {
    await cleanup(fixture);
  }
});

test('findDueSheetSyncJobs excludes syncing and synced jobs', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    const claimed = await markSheetSyncStarted(job.id);
    assert.ok(claimed);

    let due = await findDueSheetSyncJobs(50);
    assert.ok(!due.some((row) => row.id === job.id), 'a syncing job must not be re-selected');

    await markSheetSyncSynced(job.id, 5);
    due = await findDueSheetSyncJobs(50);
    assert.ok(!due.some((row) => row.id === job.id), 'a synced job must never be selected again');
  } finally {
    await cleanup(fixture);
  }
});

test('markSheetSyncStarted claims a pending job: pending -> syncing, attempts += 1', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    const claimed = await markSheetSyncStarted(job.id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'syncing');
    assert.equal(claimed.attempts, 1);
  } finally {
    await cleanup(fixture);
  }
});

test('markSheetSyncStarted returns null when the job is already syncing (guards against double-claiming)', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    await markSheetSyncStarted(job.id);

    const secondClaim = await markSheetSyncStarted(job.id);
    assert.equal(secondClaim, null);
  } finally {
    await cleanup(fixture);
  }
});

test('markSheetSyncSynced marks the job synced, records the sheet row number, sets synced_at, and clears last_error', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    await markSheetSyncStarted(job.id);
    await markSheetSyncFailed(job.id, 'transient Sheets API error');

    const synced = await markSheetSyncSynced(job.id, 7);
    assert.ok(synced);
    assert.equal(synced.status, 'synced');
    assert.equal(synced.sheetRowNumber, 7);
    assert.ok(synced.syncedAt !== null);
    assert.equal(synced.lastError, null, 'a prior failure error must be cleared once the job actually succeeds');
  } finally {
    await cleanup(fixture);
  }
});

test('markSheetSyncFailed preserves the attempt count from markSheetSyncStarted, records the error, and reschedules next_attempt_at', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    const claimed = await markSheetSyncStarted(job.id);
    assert.ok(claimed);
    assert.equal(claimed.attempts, 1);

    const future = new Date(Date.now() + 5 * 60_000);
    const failed = await markSheetSyncFailed(job.id, 'Sheets API quota exceeded', future);
    assert.ok(failed);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1, 'markSheetSyncFailed itself never increments attempts — that happens on claim');
    assert.equal(failed.lastError, 'Sheets API quota exceeded');
    assert.equal(new Date(failed.nextAttemptAt).getTime(), future.getTime());

    // A subsequent retry claim increments attempts again — the counter
    // tracks how many times the job has been *attempted*, not how many
    // times it has failed.
    const reclaimed = await markSheetSyncStarted(job.id);
    assert.ok(reclaimed);
    assert.equal(reclaimed.attempts, 2);
  } finally {
    await cleanup(fixture);
  }
});

test('findSheetSyncQueueByTelegramMessageId finds the job for a given message', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    const found = await findSheetSyncQueueByTelegramMessageId(fixture.telegramMessageId);
    assert.ok(found);
    assert.equal(found.id, job.id);
  } finally {
    await cleanup(fixture);
  }
});

test('recoverStaleSyncingJobs requeues a stale syncing job back to pending when attempts remain', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    await markSheetSyncStarted(job.id); // attempts = 1, status = syncing
    await backdateUpdatedAtMinutes(job.id, 20);

    const { requeued, failed } = await recoverStaleSyncingJobs(10, 5);
    assert.ok(requeued.some((row) => row.id === job.id));
    assert.ok(!failed.some((row) => row.id === job.id));

    const after = await findSheetSyncQueueByTelegramMessageId(fixture.telegramMessageId);
    assert.ok(after);
    assert.equal(after.status, 'pending');
  } finally {
    await cleanup(fixture);
  }
});

test('recoverStaleSyncingJobs gives up (failed) a stale syncing job once max attempts is reached', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    await markSheetSyncStarted(job.id); // attempts = 1
    await backdateUpdatedAtMinutes(job.id, 20);

    const { requeued, failed } = await recoverStaleSyncingJobs(10, 1); // maxAttempts=1, attempts already at 1
    assert.ok(!requeued.some((row) => row.id === job.id));
    assert.ok(failed.some((row) => row.id === job.id));

    const after = await findSheetSyncQueueByTelegramMessageId(fixture.telegramMessageId);
    assert.ok(after);
    assert.equal(after.status, 'failed');
  } finally {
    await cleanup(fixture);
  }
});

// --- B-4: max-attempts cap on the normal (non-crash) retry path -----------

/** Runs one claim+fail cycle (markSheetSyncStarted -> markSheetSyncFailed, immediately due again) — simulates one real Sheets/API failure. */
async function failOnce(jobId: string): Promise<void> {
  const claimed = await markSheetSyncStarted(jobId);
  assert.ok(claimed, `expected to be able to claim job ${jobId}`);
  await markSheetSyncFailed(jobId, 'simulated transient Google API error', new Date());
}

test('a normal failed job keeps being returned by findDueSheetSyncJobs while attempts remain below MAX_SHEET_SYNC_ATTEMPTS', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    for (let i = 0; i < MAX_SHEET_SYNC_ATTEMPTS - 1; i++) {
      await failOnce(job.id);
      const due = await findDueSheetSyncJobs(50);
      assert.ok(
        due.some((row) => row.id === job.id),
        `expected job still due after ${i + 1}/${MAX_SHEET_SYNC_ATTEMPTS} attempts`,
      );
    }

    const record = await findSheetSyncQueueByTelegramMessageId(fixture.telegramMessageId);
    assert.ok(record);
    assert.equal(record.attempts, MAX_SHEET_SYNC_ATTEMPTS - 1);
    assert.equal(record.status, 'failed');
  } finally {
    await cleanup(fixture);
  }
});

test('findDueSheetSyncJobs stops returning a job once its attempts reach MAX_SHEET_SYNC_ATTEMPTS', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    for (let i = 0; i < MAX_SHEET_SYNC_ATTEMPTS; i++) {
      await failOnce(job.id);
    }

    const due = await findDueSheetSyncJobs(50);
    assert.ok(
      !due.some((row) => row.id === job.id),
      'a job that has exhausted MAX_SHEET_SYNC_ATTEMPTS must never be offered for another automatic retry',
    );
  } finally {
    await cleanup(fixture);
  }
});

test('a permanently exhausted job stays status=failed with its real attempts count — visible to a direct operator query, not silently dropped', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    for (let i = 0; i < MAX_SHEET_SYNC_ATTEMPTS; i++) {
      await failOnce(job.id);
    }

    const record = await findSheetSyncQueueByTelegramMessageId(fixture.telegramMessageId);
    assert.ok(record, 'the row must still exist and be queryable, never deleted or hidden');
    assert.equal(record.status, 'failed');
    assert.equal(record.attempts, MAX_SHEET_SYNC_ATTEMPTS);
    assert.equal(record.lastError, 'simulated transient Google API error');
  } finally {
    await cleanup(fixture);
  }
});

test('markSheetSyncFailed still stores exactly the error string it is given (sanitization is the caller — syncPassportRowToSheet.ts — not this repository function)', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);
    await markSheetSyncStarted(job.id);

    const boundedMessage = 'x'.repeat(300); // shape a caller's already-sanitized/truncated message would have
    const failed = await markSheetSyncFailed(job.id, boundedMessage, new Date());
    assert.ok(failed);
    assert.equal(failed.lastError, boundedMessage);
    assert.equal(failed.lastError?.length, 300);
  } finally {
    await cleanup(fixture);
  }
});

test('a job stuck in syncing below MAX_SHEET_SYNC_ATTEMPTS, once recovered, flows back into the same attempts-aware findDueSheetSyncJobs', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const job = await enqueueSheetSync(fixture.telegramMessageId);
    assert.ok(job);

    // Fail a couple of times first, then get stuck mid-'syncing' on the next claim (simulated crash).
    await failOnce(job.id);
    await failOnce(job.id);
    const claimed = await markSheetSyncStarted(job.id);
    assert.ok(claimed);
    assert.equal(claimed.attempts, 3);
    assert.ok(claimed.attempts < MAX_SHEET_SYNC_ATTEMPTS);

    await backdateUpdatedAtMinutes(job.id, 20);
    const { requeued } = await recoverStaleSyncingJobs(10, MAX_SHEET_SYNC_ATTEMPTS);
    assert.ok(requeued.some((row) => row.id === job.id));

    const due = await findDueSheetSyncJobs(50);
    assert.ok(
      due.some((row) => row.id === job.id),
      'recovered-and-still-under-budget job must be offered for normal retry again',
    );

    const record = await findSheetSyncQueueByTelegramMessageId(fixture.telegramMessageId);
    assert.ok(record);
    assert.equal(record.attempts, 3, 'recovery must never bump attempts on its own — only markSheetSyncStarted does');
  } finally {
    await cleanup(fixture);
  }
});

after(async () => {
  await pool.end();
});
