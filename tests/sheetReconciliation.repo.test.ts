import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import {
  claimReconciliationJob,
  findDueReconciliationJobs,
  findReconciliationJobById,
  findReconciliationJobsForIdentityGroup,
  insertReconciliationJobWithClient,
  markReconciliationJobDone,
  markReconciliationJobFailed,
  MAX_RECONCILIATION_ATTEMPTS,
  recoverStaleReconciliationJobs,
  STALE_RECONCILIATION_TIMEOUT_MINUTES,
} from '../src/db/repositories/sheetReconciliation.repo.js';

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
function uniquePassportNumber(): string {
  idCounter += 1;
  return `RECONCILETEST${Date.now()}${idCounter}`;
}

interface Fixture {
  groupId: string;
  telegramMessageId: string;
  passportIdentityId: string;
  chatId: number;
}

async function createFixture(): Promise<Fixture> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Reconciliation Repo Test Group', '2026-09-20', chatId],
  );
  assert.ok(group);
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id
     ) VALUES ($1,$2,$3,'Reconciliation Repo Test Sender', now(), 'FILE_RECONCILE_REPO_TEST', $4)
     RETURNING id`,
    [chatId, uniqueMessageId(), uniqueUserId(), group.id],
  );
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(message);
  assert.ok(identity);
  return { groupId: group.id, telegramMessageId: message.id, passportIdentityId: identity.id, chatId };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await pool.query(`DELETE FROM sheet_reconciliation_jobs WHERE passport_identity_id = $1`, [fixture.passportIdentityId]);
  await pool.query(`DELETE FROM passport_identity WHERE id = $1`, [fixture.passportIdentityId]);
  await pool.query(`DELETE FROM telegram_messages WHERE group_id = $1`, [fixture.groupId]);
  await pool.query(`DELETE FROM groups WHERE id = $1`, [fixture.groupId]);
}

async function insertJob(fixture: Fixture, sourceOperation = 'cancel_passport'): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertReconciliationJobWithClient(client, {
      passportIdentityId: fixture.passportIdentityId,
      groupId: fixture.groupId,
      expectedOldCanonicalTelegramMessageId: fixture.telegramMessageId,
      sourceOperation,
      sourceEventId: null,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const jobs = await findReconciliationJobsForIdentityGroup(fixture.passportIdentityId, fixture.groupId);
  const job = jobs[jobs.length - 1];
  assert.ok(job);
  return job.id;
}

test('insertReconciliationJobWithClient inserts a pending job visible after commit', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);
    const job = await findReconciliationJobById(jobId);
    assert.equal(job?.status, 'pending');
    assert.equal(job?.expectedOldCanonicalTelegramMessageId, fixture.telegramMessageId);
    assert.equal(job?.attempts, 0);
  } finally {
    await cleanup(fixture);
  }
});

test('insertReconciliationJobWithClient rolled back with its transaction is never visible', async () => {
  const fixture = await createFixture();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertReconciliationJobWithClient(client, {
        passportIdentityId: fixture.passportIdentityId,
        groupId: fixture.groupId,
        expectedOldCanonicalTelegramMessageId: fixture.telegramMessageId,
        sourceOperation: 'cancel_passport',
        sourceEventId: null,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const jobs = await findReconciliationJobsForIdentityGroup(fixture.passportIdentityId, fixture.groupId);
    assert.equal(jobs.length, 0, 'a rolled-back transaction never leaves a durable job behind -- this IS the crash-safety guarantee');
  } finally {
    await cleanup(fixture);
  }
});

test('findDueReconciliationJobs finds a pending job, claimReconciliationJob claims it atomically', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);

    const due = await findDueReconciliationJobs(50);
    assert.ok(due.some((j) => j.id === jobId));

    const claimed = await claimReconciliationJob(jobId);
    assert.equal(claimed?.status, 'processing');
    assert.equal(claimed?.attempts, 1);

    const dueAfterClaim = await findDueReconciliationJobs(50);
    assert.ok(!dueAfterClaim.some((j) => j.id === jobId), 'a processing job is not due again');

    const secondClaim = await claimReconciliationJob(jobId);
    assert.equal(secondClaim, null, 'a second claim of an already-processing job must fail');
  } finally {
    await cleanup(fixture);
  }
});

test('markReconciliationJobDone marks it done and clears last_error', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);
    await claimReconciliationJob(jobId);
    await markReconciliationJobFailed(jobId, 'transient error');
    await claimReconciliationJob(jobId);
    const done = await markReconciliationJobDone(jobId);
    assert.equal(done?.status, 'done');
    assert.equal(done?.lastError, null);
    assert.ok(done?.completedAt);
  } finally {
    await cleanup(fixture);
  }
});

test('markReconciliationJobFailed records the error and schedules a retry', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);
    await claimReconciliationJob(jobId);
    const future = new Date(Date.now() + 60_000);
    const failed = await markReconciliationJobFailed(jobId, 'Sheets API unavailable', future);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lastError, 'Sheets API unavailable');

    const dueNow = await findDueReconciliationJobs(50);
    assert.ok(!dueNow.some((j) => j.id === jobId), 'not due yet -- next_attempt_at is in the future');
  } finally {
    await cleanup(fixture);
  }
});

test('a failed job past its next_attempt_at becomes due again (retry)', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);
    await claimReconciliationJob(jobId);
    await markReconciliationJobFailed(jobId, 'transient', new Date(Date.now() - 1000));

    const due = await findDueReconciliationJobs(50);
    assert.ok(due.some((j) => j.id === jobId));
  } finally {
    await cleanup(fixture);
  }
});

test('a job that reaches MAX_RECONCILIATION_ATTEMPTS is excluded from findDueReconciliationJobs (visible, not silently dropped)', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);
    for (let i = 0; i < MAX_RECONCILIATION_ATTEMPTS; i += 1) {
      await claimReconciliationJob(jobId);
      await markReconciliationJobFailed(jobId, `attempt ${i}`, new Date(Date.now() - 1000));
    }

    const due = await findDueReconciliationJobs(50);
    assert.ok(!due.some((j) => j.id === jobId), 'exhausted its attempt budget -- never offered again');

    const stillThere = await findReconciliationJobById(jobId);
    assert.equal(stillThere?.status, 'failed');
    assert.equal(stillThere?.attempts, MAX_RECONCILIATION_ATTEMPTS);
  } finally {
    await cleanup(fixture);
  }
});

async function backdateUpdatedAtMinutes(id: string, minutesAgo: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`UPDATE sheet_reconciliation_jobs SET updated_at = now() - ($2 * interval '1 minute') WHERE id = $1`, [
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

test('recoverStaleReconciliationJobs requeues a job abandoned mid-processing (crash recovery)', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);
    await claimReconciliationJob(jobId); // -> processing, simulating a worker that then crashed
    await backdateUpdatedAtMinutes(jobId, STALE_RECONCILIATION_TIMEOUT_MINUTES + 1);

    const { requeued, failed } = await recoverStaleReconciliationJobs();
    assert.ok(requeued.some((j) => j.id === jobId));
    assert.ok(!failed.some((j) => j.id === jobId));

    const due = await findDueReconciliationJobs(50);
    assert.ok(due.some((j) => j.id === jobId), 'once recovered, the exact function the real loop polls must find it again');
  } finally {
    await cleanup(fixture);
  }
});

test('recoverStaleReconciliationJobs gives up on a stale job that already exhausted its attempt budget', async () => {
  const fixture = await createFixture();
  try {
    const jobId = await insertJob(fixture);
    for (let i = 0; i < MAX_RECONCILIATION_ATTEMPTS - 1; i += 1) {
      await claimReconciliationJob(jobId);
      await markReconciliationJobFailed(jobId, `attempt ${i}`, new Date(Date.now() - 1000));
    }
    await claimReconciliationJob(jobId); // final attempt -> stuck in processing (simulated crash)
    await backdateUpdatedAtMinutes(jobId, STALE_RECONCILIATION_TIMEOUT_MINUTES + 1);

    const { requeued, failed } = await recoverStaleReconciliationJobs();
    assert.ok(!requeued.some((j) => j.id === jobId));
    assert.ok(failed.some((j) => j.id === jobId));

    const finalJob = await findReconciliationJobById(jobId);
    assert.equal(finalJob?.status, 'failed');
  } finally {
    await cleanup(fixture);
  }
});

after(async () => {
  await pool.end();
});
