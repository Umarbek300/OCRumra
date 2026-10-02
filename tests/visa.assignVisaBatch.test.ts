import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import {
  countActiveApplicantsInBatch,
  findLastBatchForGroup,
  updateActiveAssignmentsStatusWithClient,
  updateBatchStatus,
} from '../src/db/repositories/visaBatches.repo.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `VISABATCHTEST${Date.now()}${idCounter}`;
}

async function createGroup(departureDate = '2026-10-05'): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Visa Batch Test Group', departureDate, uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createIdentity(): Promise<string> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  return identity.id;
}

async function cleanupAll(groupIds: string[], identityIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
  }
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM passport_identity WHERE id = $1`, [identityId]);
  }
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

test('first applicant -> batch 1, position 1', async () => {
  const groupId = await createGroup();
  const identityId = await createIdentity();
  try {
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    assert.equal(assignment.positionInBatch, 1);
    const batch = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.equal(batch?.batchNumber, 1);
    assert.equal(batch?.batchName, '5.10-1');
    assert.equal(batch?.status, 'pending');
  } finally {
    await cleanupAll([groupId], [identityId]);
  }
});

test('10 applicants all land in batch 1', async () => {
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    for (let i = 0; i < 10; i += 1) {
      const identityId = await createIdentity();
      identityIds.push(identityId);
      await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    }
    const batch = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.equal(batch?.batchNumber, 1);
    const count = await countActiveApplicantsInBatch(batch!.id);
    assert.equal(count, 10);
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('11th applicant opens batch 2, position 1', async () => {
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    for (let i = 0; i < 11; i += 1) {
      const identityId = await createIdentity();
      identityIds.push(identityId);
      await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    }
    const batch = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.equal(batch?.batchNumber, 2);
    assert.equal(batch?.batchName, '5.10-2');
    const count = await countActiveApplicantsInBatch(batch!.id);
    assert.equal(count, 1);
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('20 applicants -> exactly 2 batches', async () => {
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    for (let i = 0; i < 20; i += 1) {
      const identityId = await createIdentity();
      identityIds.push(identityId);
      await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    }
    const batch = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.equal(batch?.batchNumber, 2);
    const count = await countActiveApplicantsInBatch(batch!.id);
    assert.equal(count, 10);
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('37 applicants -> exactly 4 batches, last one has 7', async () => {
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    for (let i = 0; i < 37; i += 1) {
      const identityId = await createIdentity();
      identityIds.push(identityId);
      await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    }
    const batch = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.equal(batch?.batchNumber, 4);
    const count = await countActiveApplicantsInBatch(batch!.id);
    assert.equal(count, 7);
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('100 applicants -> exactly 10 batches', async () => {
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    for (let i = 0; i < 100; i += 1) {
      const identityId = await createIdentity();
      identityIds.push(identityId);
      await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    }
    const batch = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.equal(batch?.batchNumber, 10);
    const count = await countActiveApplicantsInBatch(batch!.id);
    assert.equal(count, 10);
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('calling assignVisaBatch twice for the same applicant never creates a duplicate assignment', async () => {
  const groupId = await createGroup();
  const identityId = await createIdentity();
  try {
    const first = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    const second = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    assert.equal(first.id, second.id);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_batch_applicants WHERE group_id = $1 AND passport_identity_id = $2`,
      [groupId, identityId],
    );
    assert.equal(rows[0]?.count, '1', 'idempotent -- never a second row for the same (group, identity, portal)');
  } finally {
    await cleanupAll([groupId], [identityId]);
  }
});

test('a submitted batch never receives a new applicant -- a new batch opens instead', async () => {
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    const firstIdentity = await createIdentity();
    identityIds.push(firstIdentity);
    const firstAssignment = await assignVisaBatch(groupId, firstIdentity, 'visitsaudi', '2026-10-05');
    await updateBatchStatus(firstAssignment.batchId, 'submitted');

    const secondIdentity = await createIdentity();
    identityIds.push(secondIdentity);
    const secondAssignment = await assignVisaBatch(groupId, secondIdentity, 'visitsaudi', '2026-10-05');

    assert.notEqual(secondAssignment.batchId, firstAssignment.batchId);
    const newBatch = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.equal(newBatch?.batchNumber, 2);
    assert.equal(newBatch?.status, 'pending');
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('a removed applicant no longer counts toward the active total', async () => {
  const groupId = await createGroup();
  const identityId = await createIdentity();
  try {
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await updateActiveAssignmentsStatusWithClient(client, groupId, identityId, 'removed');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const count = await countActiveApplicantsInBatch(assignment.batchId);
    assert.equal(count, 0);
  } finally {
    await cleanupAll([groupId], [identityId]);
  }
});

test("a new applicant can take over the position vacated by a removed applicant in a still-pending batch", async () => {
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    const removedIdentity = await createIdentity();
    identityIds.push(removedIdentity);
    const removedAssignment = await assignVisaBatch(groupId, removedIdentity, 'visitsaudi', '2026-10-05');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await updateActiveAssignmentsStatusWithClient(client, groupId, removedIdentity, 'removed');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const newIdentity = await createIdentity();
    identityIds.push(newIdentity);
    const newAssignment = await assignVisaBatch(groupId, newIdentity, 'visitsaudi', '2026-10-05');

    assert.equal(newAssignment.batchId, removedAssignment.batchId);
    assert.equal(newAssignment.positionInBatch, removedAssignment.positionInBatch, 'reuses the freed position');
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('a cancelled applicant no longer counts toward the active total (symmetry with removed)', async () => {
  const groupId = await createGroup();
  const identityId = await createIdentity();
  try {
    const assignment = await assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await updateActiveAssignmentsStatusWithClient(client, groupId, identityId, 'cancelled');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const count = await countActiveApplicantsInBatch(assignment.batchId);
    assert.equal(count, 0);
  } finally {
    await cleanupAll([groupId], [identityId]);
  }
});

test('11 applicants assigned truly CONCURRENTLY (Promise.all, not sequentially) all succeed with no duplicate position and no unhandled error', async () => {
  // Regression test for the race window between findFreePositionInBatch's
  // read and createVisaBatchAssignment's INSERT: createVisaBatchAssignment's
  // own ON CONFLICT only suppresses a violation of
  // idx_visa_batch_applicants_one_active_assignment (the identity-uniqueness
  // index) -- a violation of the OTHER partial unique index,
  // idx_visa_batch_applicants_position_active, is a different arbiter and
  // is NOT suppressed by that clause, so it still raises a real Postgres
  // error when two DIFFERENT applicants race for the same computed free
  // position in the same batch. Every earlier test in this file calls
  // assignVisaBatch sequentially (awaited one at a time), which can never
  // exercise this window at all -- only genuine concurrent callers (via
  // Promise.all, as here) can trigger it.
  const groupId = await createGroup();
  const identityIds: string[] = [];
  try {
    for (let i = 0; i < 11; i += 1) {
      identityIds.push(await createIdentity());
    }

    const assignments = await Promise.all(
      identityIds.map((identityId) => assignVisaBatch(groupId, identityId, 'visitsaudi', '2026-10-05')),
    );

    assert.equal(assignments.length, 11, 'every concurrent call resolved -- none threw an unhandled unique_violation');

    const batch1 = await findLastBatchForGroup(groupId, 'visitsaudi');
    assert.ok(batch1);

    const { rows } = await pool.query<{ batch_id: string; position_in_batch: number; count: string }>(
      `SELECT batch_id, position_in_batch, count(*)::text AS count
       FROM visa_batch_applicants
       WHERE group_id = $1 AND status = 'active'
       GROUP BY batch_id, position_in_batch
       HAVING count(*) > 1`,
      [groupId],
    );
    assert.equal(rows.length, 0, 'no (batch_id, position_in_batch) pair was ever double-assigned under real concurrency');

    const distinctIdentities = new Set(assignments.map((a) => a.passportIdentityId));
    assert.equal(distinctIdentities.size, 11, 'all 11 applicants got their own distinct assignment, none silently merged/lost');

    const batchNumbers = new Set(assignments.map((a) => a.batchId));
    assert.equal(batchNumbers.size, 2, 'exactly 2 batches were ever created under this concurrent load, never more');
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});
