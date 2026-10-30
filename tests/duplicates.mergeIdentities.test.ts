import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportOcrResult } from '../src/db/repositories/passportOcrResult.repo.js';
import { createPassportIdentity, findPassportIdentityById } from '../src/db/repositories/passportIdentity.repo.js';
import {
  createPassportMessageLink,
  findAllLinksWithConfidenceForIdentity,
  findPassportMessageLinkById,
} from '../src/db/repositories/passportMessageLinks.repo.js';
import { listEventsForIdentity } from '../src/db/repositories/passportIdentityEvents.repo.js';
import { findReconciliationJobsForIdentityGroup } from '../src/db/repositories/sheetReconciliation.repo.js';
import { mergeIdentitiesTransaction } from '../src/duplicates/applyIdentityStateChange.js';
import { mergeIdentities, type MergeIdentitiesDependencies } from '../src/duplicates/mergeIdentities.js';
import { createVisaBatch, createVisaBatchAssignment } from '../src/db/repositories/visaBatches.repo.js';
import { claimForSubmission, createQueueForBatch, createSubmissionAttempt } from '../src/db/repositories/visaSubmissionQueue.repo.js';

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
  return `MERGETEST${Date.now()}${idCounter}`;
}

async function createGroup(): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Merge Test Group', '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Merge Test Agent', uniqueUserId()],
  );
  assert.ok(agent);
  return agent.id;
}

async function createMessage(groupId: string, agentId: string | null): Promise<string> {
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Merge Test Sender', now(), 'FILE_MERGE_TEST', $4, $5)
     RETURNING id`,
    [uniqueChatId(), uniqueMessageId(), uniqueUserId(), groupId, agentId],
  );
  assert.ok(message);
  return message.id;
}

async function createOcrResult(
  telegramMessageId: string,
  passportNumberConfidence: 'high' | 'medium' | 'low' = 'high',
  dobConfidence: 'high' | 'medium' | 'low' = 'high',
): Promise<void> {
  await createPassportOcrResult({
    telegramMessageId,
    firstName: { value: 'JOHN', confidence: 'high' },
    middleName: { value: null, confidence: null },
    surname: { value: 'DOE', confidence: 'high' },
    passportNumber: { value: 'AB1234567', confidence: passportNumberConfidence },
    dateOfBirth: { value: '1990-01-01', confidence: dobConfidence },
    passportIssueDate: { value: '2020-01-01', confidence: 'high' },
    passportExpiryDate: { value: '2030-01-01', confidence: 'high' },
    gender: { value: 'male', confidence: 'high' },
    nationality: { value: 'UZ', confidence: 'high' },
    placeOfBirth: { value: null, confidence: null },
    issuingAuthority: { value: null, confidence: null },
    mrz: { value: null, confidence: null },
    overallConfidence: 'high',
    rawResponse: {},
    provider: 'google-vision',
    model: 'test-model',
  });
}

async function cleanupAll(groupIds: string[], agentIds: string[], identityIds: string[]): Promise<void> {
  // Visa cleanup first -- visa_submission_queue (and what FK-references it)
  // must be cleared before visa_batch_applicants, which must be cleared
  // before groups. Package 5.6's own tests are the first in this file to
  // create any visa fixtures at all.
  for (const groupId of groupIds) {
    await pool.query(
      `DELETE FROM visa_operator_alerts WHERE visa_submission_queue_id IN (
         SELECT id FROM visa_submission_queue WHERE group_id = $1
       )`,
      [groupId],
    );
    await pool.query(`DELETE FROM visa_submission_queue WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)`, [
      groupId,
    ]);
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
  }
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM sheet_reconciliation_jobs WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_message_links WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM duplicate_reviews WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_identity_events WHERE passport_identity_id = $1`, [identityId]);
  }
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM telegram_messages WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
  for (const agentId of agentIds) {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
  }
  for (const identityId of identityIds) {
    await pool.query(`UPDATE passport_identity SET merged_into_identity_id = NULL WHERE merged_into_identity_id = $1`, [identityId]);
  }
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM passport_identity WHERE id = $1`, [identityId]);
  }
}

/** Creates one active visa_batch_applicants assignment AND its visa_submission_queue row (optionally claimed into SUBMITTING) for (groupId, identityId) -- the Package 5.6 merge-retirement tests below need a real queue row, not just a bare assignment. */
async function createVisaAssignmentWithQueue(
  groupId: string,
  identityId: string,
  queueStatus: 'PENDING' | 'SUBMITTING',
): Promise<{ assignmentId: string; queueId: string }> {
  const batch = await createVisaBatch({ groupId, portal: 'visitsaudi', batchNumber: 1, batchName: 'test-batch-1' });
  const result = await createVisaBatchAssignment({
    batchId: batch.id,
    groupId,
    passportIdentityId: identityId,
    portal: 'visitsaudi',
    positionInBatch: 1,
  });
  assert.equal(result.outcome, 'inserted');
  if (result.outcome !== 'inserted') throw new Error('unreachable');

  const attempt = await createSubmissionAttempt(batch.id, 'operator:test');
  const created = await createQueueForBatch(batch.id, attempt.id);
  const queueRow = created?.[0];
  assert.ok(queueRow);

  if (queueStatus === 'SUBMITTING') {
    const claimed = await claimForSubmission(queueRow.id);
    assert.ok(claimed);
  }

  return { assignmentId: result.assignment.id, queueId: queueRow.id };
}

async function getVisaAssignmentStatus(assignmentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM visa_batch_applicants WHERE id = $1`, [assignmentId]);
  return rows[0]?.status ?? null;
}

async function getQueueStatusAndConflict(queueId: string): Promise<{ status: string; conflictDetectedAt: string | null }> {
  const { rows } = await pool.query<{ status: string; conflict_detected_at: string | null }>(
    `SELECT status, conflict_detected_at FROM visa_submission_queue WHERE id = $1`,
    [queueId],
  );
  return { status: rows[0]?.status ?? '', conflictDetectedAt: rows[0]?.conflict_detected_at ?? null };
}

async function countConflictAlerts(queueId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM visa_operator_alerts WHERE visa_submission_queue_id = $1 AND alert_type = 'conflict'`,
    [queueId],
  );
  return Number(rows[0]?.count ?? '0');
}

function fakeDeps(overrides: Partial<MergeIdentitiesDependencies> = {}): { deps: MergeIdentitiesDependencies } {
  const deps: MergeIdentitiesDependencies = {
    findIdentity: findPassportIdentityById,
    findLinks: findAllLinksWithConfidenceForIdentity,
    applyMerge: mergeIdentitiesTransaction,
    ...overrides,
  };

  return { deps };
}

test('mergeIdentities picks the identity with the STRONGER field-level evidence as survivor', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  const agentId = await createAgent();
  const weakMessage = await createMessage(groupA, agentId);
  const strongMessage = await createMessage(groupB, agentId);
  await createOcrResult(weakMessage, 'medium', 'medium');
  await createOcrResult(strongMessage, 'high', 'high');

  const weakIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const strongIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
  assert.ok(weakIdentity);
  assert.ok(strongIdentity);
  await createPassportMessageLink({
    passportIdentityId: weakIdentity.id,
    telegramMessageId: weakMessage,
    groupId: groupA,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'review',
    resolvedBy: 'operator',
  });
  await createPassportMessageLink({
    passportIdentityId: strongIdentity.id,
    telegramMessageId: strongMessage,
    groupId: groupB,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const { deps } = fakeDeps();
    const result = await mergeIdentities(weakIdentity.id, strongIdentity.id, 'operator-1', deps);

    assert.equal(result.survivorId, strongIdentity.id);
    assert.equal(result.loserId, weakIdentity.id);

    const loser = await findPassportIdentityById(weakIdentity.id);
    assert.equal(loser?.status, 'merged');
    assert.equal(loser?.mergedIntoIdentityId, strongIdentity.id);

    const survivor = await findPassportIdentityById(strongIdentity.id);
    assert.equal(survivor?.status, 'active', 'the survivor itself is never state-transitioned');

    // Neither row is physically deleted.
    assert.ok(loser);
    assert.ok(survivor);

    const jobsA = await findReconciliationJobsForIdentityGroup(strongIdentity.id, groupA);
    const jobsB = await findReconciliationJobsForIdentityGroup(strongIdentity.id, groupB);
    assert.equal(jobsA.length + jobsB.length, 0, 'no same-group conflict here -- nothing stale to reconcile in the Sheet');
  } finally {
    await cleanupAll([groupA, groupB], [agentId], [weakIdentity.id, strongIdentity.id]);
  }
});

test('mergeIdentities absorbs the loser\'s canonical link into the survivor when there is no group conflict', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  const agentId = await createAgent();
  const loserMessage = await createMessage(groupA, agentId);
  const survivorMessage = await createMessage(groupB, agentId);
  await createOcrResult(loserMessage);
  await createOcrResult(survivorMessage);

  const identityA = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const identityB = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
  assert.ok(identityA);
  assert.ok(identityB);
  const loserLink = await createPassportMessageLink({
    passportIdentityId: identityA.id,
    telegramMessageId: loserMessage,
    groupId: groupA,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: identityB.id,
    telegramMessageId: survivorMessage,
    groupId: groupB,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(loserLink);

  try {
    // Same evidence score on both sides -> tie-break by earlier created_at.
    // identityA was created first (created before identityB above), so it survives.
    const { deps } = fakeDeps();
    const result = await mergeIdentities(identityA.id, identityB.id, 'operator-1', deps);
    assert.equal(result.survivorId, identityA.id);

    const absorbedLink = await findPassportMessageLinkById(loserLink.id);
    assert.equal(absorbedLink?.passportIdentityId, identityA.id, 'unchanged -- this link already belonged to the survivor');

    // The loser's (identityB's) link must now be absorbed into the survivor (identityA), staying canonical since groupB had no conflict.
    const { rows } = await pool.query<{ id: string; passport_identity_id: string; role: string; group_id: string }>(
      `SELECT id, passport_identity_id, role, group_id FROM passport_message_links WHERE telegram_message_id = $1`,
      [survivorMessage],
    );
    assert.equal(rows[0]?.passport_identity_id, identityA.id);
    assert.equal(rows[0]?.role, 'canonical');
    assert.equal(rows[0]?.group_id, groupB, "the link's own group is preserved through the absorption");

    const jobsA = await findReconciliationJobsForIdentityGroup(identityA.id, groupA);
    const jobsB = await findReconciliationJobsForIdentityGroup(identityA.id, groupB);
    assert.equal(jobsA.length + jobsB.length, 0, 'absorbing a canonical into a DIFFERENT, non-conflicting group needs no Sheet reconciliation at all');
  } finally {
    await cleanupAll([groupA, groupB], [agentId], [identityA.id, identityB.id]);
  }
});

test('mergeIdentities resolves a same-group canonical conflict by demoting the weaker side, never leaving two canonicals', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const weakMessage = await createMessage(groupId, agentId);
  const strongMessage = await createMessage(groupId, agentId);
  await createOcrResult(weakMessage, 'medium', 'high');
  await createOcrResult(strongMessage, 'high', 'high');

  const weakIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const strongIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
  assert.ok(weakIdentity);
  assert.ok(strongIdentity);
  const weakLink = await createPassportMessageLink({
    passportIdentityId: weakIdentity.id,
    telegramMessageId: weakMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  const strongLink = await createPassportMessageLink({
    passportIdentityId: strongIdentity.id,
    telegramMessageId: strongMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(weakLink);
  assert.ok(strongLink);

  try {
    // Overall evidence: weakIdentity has ONE weak link, strongIdentity has ONE strong link -- strongIdentity survives.
    const { deps } = fakeDeps();
    const result = await mergeIdentities(weakIdentity.id, strongIdentity.id, 'operator-1', deps);
    assert.equal(result.survivorId, strongIdentity.id);

    // After the merge, exactly ONE active canonical must exist for (survivor, groupId) -- the pre-existing strong one, never both.
    const { rows } = await pool.query<{ id: string; role: string; link_status: string }>(
      `SELECT id, role, link_status FROM passport_message_links WHERE passport_identity_id = $1 AND group_id = $2 AND role = 'canonical' AND link_status = 'active'`,
      [strongIdentity.id, groupId],
    );
    assert.equal(rows.length, 1, 'the partial unique index constraint must never be violated by a merge');
    assert.equal(rows[0]?.id, strongLink.id, 'the pre-existing stronger link keeps canonical status');

    const demotedWeakLink = await findPassportMessageLinkById(weakLink.id);
    assert.equal(demotedWeakLink?.role, 'duplicate');
    assert.equal(demotedWeakLink?.passportIdentityId, strongIdentity.id, 'absorbed into the survivor, just demoted');

    // P1: the demoted (weak) side's Sheet row is now stale (no longer an
    // active operational record) -- a durable reconciliation job is
    // enqueued for it, anchored at the demoted message, IN THE SAME
    // transaction as the domain change -- never a direct Sheets call.
    const jobs = await findReconciliationJobsForIdentityGroup(strongIdentity.id, groupId);
    assert.equal(jobs.length, 1, 'exactly one stale row -- the demoted side -- needs reconciliation');
    assert.equal(jobs[0]?.expectedOldCanonicalTelegramMessageId, weakMessage, 'the DEMOTED weak message\'s row is the one anchored for reconciliation');
    assert.equal(jobs[0]?.sourceOperation, 'merge');
    assert.equal(jobs[0]?.status, 'pending');
  } finally {
    await cleanupAll([groupId], [agentId], [weakIdentity.id, strongIdentity.id]);
  }
});

test('mergeIdentities deletes the SURVIVOR\'s own stale row when the LOSER wins a same-group canonical conflict', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  // Survivor overall (identityB) has the stronger OVERALL evidence via a
  // second, unrelated strong link in another group -- but within the
  // CONFLICTING group, its own canonical link is the WEAKER one, so the
  // loser's (identityA's) canonical link should win that specific conflict.
  const otherGroupId = await createGroup();
  const survivorStrongMessage = await createMessage(otherGroupId, agentId);
  const survivorWeakInConflictMessage = await createMessage(groupId, agentId);
  const loserStrongInConflictMessage = await createMessage(groupId, agentId);
  await createOcrResult(survivorStrongMessage, 'high', 'high');
  await createOcrResult(survivorWeakInConflictMessage, 'low', 'low');
  // Strictly stronger than the survivor's in-conflict link (so it wins that
  // conflict), but strictly weaker than the survivor's OTHER, unrelated
  // link (so identityB is still the overall survivor, no tie-break needed).
  await createOcrResult(loserStrongInConflictMessage, 'medium', 'high');

  const identityA = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const identityB = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
  assert.ok(identityA);
  assert.ok(identityB);
  const loserLink = await createPassportMessageLink({
    passportIdentityId: identityA.id,
    telegramMessageId: loserStrongInConflictMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  const survivorConflictLink = await createPassportMessageLink({
    passportIdentityId: identityB.id,
    telegramMessageId: survivorWeakInConflictMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: identityB.id,
    telegramMessageId: survivorStrongMessage,
    groupId: otherGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(loserLink);
  assert.ok(survivorConflictLink);

  try {
    const { deps } = fakeDeps();
    const result = await mergeIdentities(identityA.id, identityB.id, 'operator-1', deps);
    assert.equal(result.survivorId, identityB.id, 'identityB has the stronger overall evidence (its second, unrelated strong link)');

    const winningLink = await findPassportMessageLinkById(loserLink.id);
    assert.equal(winningLink?.role, 'canonical', 'the loser\'s OWN stronger-in-conflict link wins the group-level conflict');
    assert.equal(winningLink?.passportIdentityId, identityB.id);

    const demotedSurvivorLink = await findPassportMessageLinkById(survivorConflictLink.id);
    assert.equal(demotedSurvivorLink?.role, 'duplicate', 'the survivor\'s OWN pre-existing canonical is demoted when it loses the conflict');

    const jobs = await findReconciliationJobsForIdentityGroup(identityB.id, groupId);
    assert.equal(jobs.length, 1);
    assert.equal(
      jobs[0]?.expectedOldCanonicalTelegramMessageId,
      survivorWeakInConflictMessage,
      'the SURVIVOR\'s own now-stale row is anchored for reconciliation, even though the survivor identity itself is not deleted',
    );
    assert.equal(jobs[0]?.sourceOperation, 'merge');

    const otherGroupJobs = await findReconciliationJobsForIdentityGroup(identityB.id, otherGroupId);
    assert.equal(otherGroupJobs.length, 0, 'the unrelated group is never touched');
  } finally {
    await cleanupAll([groupId, otherGroupId], [agentId], [identityA.id, identityB.id]);
  }
});

test('mergeIdentities leaves an unrelated group\'s Sheet row completely untouched by a same-group conflict elsewhere', async () => {
  const conflictGroupId = await createGroup();
  const unrelatedGroupId = await createGroup();
  const agentId = await createAgent();
  const weakMessage = await createMessage(conflictGroupId, agentId);
  const strongMessage = await createMessage(conflictGroupId, agentId);
  const unrelatedMessage = await createMessage(unrelatedGroupId, agentId);
  await createOcrResult(weakMessage, 'medium', 'high');
  await createOcrResult(strongMessage, 'high', 'high');
  await createOcrResult(unrelatedMessage, 'high', 'high');

  const weakIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const strongIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
  assert.ok(weakIdentity);
  assert.ok(strongIdentity);
  await createPassportMessageLink({
    passportIdentityId: weakIdentity.id,
    telegramMessageId: weakMessage,
    groupId: conflictGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: strongIdentity.id,
    telegramMessageId: strongMessage,
    groupId: conflictGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  // An unrelated, non-conflicting canonical link for the LOSER in a totally different group.
  await createPassportMessageLink({
    passportIdentityId: weakIdentity.id,
    telegramMessageId: unrelatedMessage,
    groupId: unrelatedGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const { deps } = fakeDeps();
    await mergeIdentities(weakIdentity.id, strongIdentity.id, 'operator-1', deps);

    const unrelatedGroupJobs = await findReconciliationJobsForIdentityGroup(strongIdentity.id, unrelatedGroupId);
    assert.equal(unrelatedGroupJobs.length, 0, 'the unrelated group\'s row is never touched');

    const unrelatedLink = await pool.query<{ role: string; passport_identity_id: string }>(
      `SELECT role, passport_identity_id FROM passport_message_links WHERE telegram_message_id = $1`,
      [unrelatedMessage],
    );
    assert.equal(unrelatedLink.rows[0]?.role, 'canonical', 'unaffected by the conflict in a different group');
  } finally {
    await cleanupAll([conflictGroupId, unrelatedGroupId], [agentId], [weakIdentity.id, strongIdentity.id]);
  }
});

test('mergeIdentities writes exactly ONE identity_merged event, on the survivor', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  const agentId = await createAgent();
  const messageA = await createMessage(groupA, agentId);
  const messageB = await createMessage(groupB, agentId);
  await createOcrResult(messageA);
  await createOcrResult(messageB, 'low', 'low');

  const identityA = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const identityB = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
  assert.ok(identityA);
  assert.ok(identityB);
  await createPassportMessageLink({
    passportIdentityId: identityA.id,
    telegramMessageId: messageA,
    groupId: groupA,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: identityB.id,
    telegramMessageId: messageB,
    groupId: groupB,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'review',
    resolvedBy: 'operator',
  });

  try {
    const { deps } = fakeDeps();
    const result = await mergeIdentities(identityA.id, identityB.id, 'operator-1', deps);

    const survivorEvents = await listEventsForIdentity(result.survivorId);
    const mergedEvents = survivorEvents.filter((e) => e.eventType === 'identity_merged');
    assert.equal(mergedEvents.length, 1);

    const loserEvents = await listEventsForIdentity(result.loserId);
    assert.equal(loserEvents.filter((e) => e.eventType === 'identity_merged').length, 0, 'the event is recorded on the survivor only');

    const jobsA = await findReconciliationJobsForIdentityGroup(result.survivorId, groupA);
    const jobsB = await findReconciliationJobsForIdentityGroup(result.survivorId, groupB);
    assert.equal(jobsA.length + jobsB.length, 0, 'no same-group conflict -- no reconciliation job, and exactly one merge event regardless');
  } finally {
    await cleanupAll([groupA, groupB], [agentId], [identityA.id, identityB.id]);
  }
});

// Package 5.6: mergeIdentitiesTransaction must now also retire the LOSER
// identity's active visa assignments, across EVERY group it holds one in
// (not just the group its canonical link happens to be in), detecting and
// alerting on a SUBMITTING conflict exactly like cancelWithConflictCheck
// already does -- without ever letting a conflict abort the merge itself.

test(
  'mergeIdentitiesTransaction retires the LOSER identity\'s active visa assignments across every group it holds one in -- ' +
    'PENDING left untouched (no alert), SUBMITTING flagged as a conflict (one alert) -- and the merge itself still succeeds',
  async () => {
    const groupA = await createGroup();
    const groupB = await createGroup();
    const groupC = await createGroup();
    const agentId = await createAgent();
    const weakMessage = await createMessage(groupA, agentId);
    const strongMessage = await createMessage(groupB, agentId);
    await createOcrResult(weakMessage, 'medium', 'medium');
    await createOcrResult(strongMessage, 'high', 'high');

    const weakIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
    const strongIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
    assert.ok(weakIdentity);
    assert.ok(strongIdentity);
    await createPassportMessageLink({
      passportIdentityId: weakIdentity.id,
      telegramMessageId: weakMessage,
      groupId: groupA,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'review',
      resolvedBy: 'operator',
    });
    await createPassportMessageLink({
      passportIdentityId: strongIdentity.id,
      telegramMessageId: strongMessage,
      groupId: groupB,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });

    // The LOSER-to-be (weakIdentity) holds active visa assignments in TWO
    // DIFFERENT groups -- groupA (its own link's group) and groupC (a group
    // it has no passport_message_link in at all, proving the new
    // retirement call is driven purely by passport_identity_id, never by
    // link data).
    const { assignmentId: assignmentA, queueId: queueA } = await createVisaAssignmentWithQueue(groupA, weakIdentity.id, 'PENDING');
    const { assignmentId: assignmentC, queueId: queueC } = await createVisaAssignmentWithQueue(groupC, weakIdentity.id, 'SUBMITTING');

    try {
      const { deps } = fakeDeps();
      const result = await mergeIdentities(weakIdentity.id, strongIdentity.id, 'operator-1', deps);
      assert.equal(result.loserId, weakIdentity.id, 'this test is only meaningful if weakIdentity is indeed selected as the loser');

      const loser = await findPassportIdentityById(weakIdentity.id);
      assert.equal(loser?.status, 'merged');

      assert.equal(await getVisaAssignmentStatus(assignmentA), 'removed');
      const queueAState = await getQueueStatusAndConflict(queueA);
      assert.equal(queueAState.status, 'PENDING', 'a PENDING queue row must be left untouched by retirement');
      assert.equal(queueAState.conflictDetectedAt, null);
      assert.equal(await countConflictAlerts(queueA), 0);

      assert.equal(await getVisaAssignmentStatus(assignmentC), 'removed', 'retirement proceeds regardless of the conflict');
      const queueCState = await getQueueStatusAndConflict(queueC);
      assert.equal(queueCState.status, 'SUBMITTING', 'an in-flight submission must never be reset by a merge');
      assert.ok(queueCState.conflictDetectedAt);
      assert.equal(await countConflictAlerts(queueC), 1, 'exactly one durable conflict alert must be recorded');

      // The merge's own, already-audited behavior is unaffected by the new
      // retirement step.
      const survivorEvents = await listEventsForIdentity(strongIdentity.id);
      assert.equal(survivorEvents.filter((e) => e.eventType === 'identity_merged').length, 1);
    } finally {
      await cleanupAll([groupA, groupB, groupC], [agentId], [weakIdentity.id, strongIdentity.id]);
    }
  },
);

test('mergeIdentitiesTransaction: a real SQL error (bad reconciliation-job FK) rolls back the WHOLE merge, including the loser\'s visa assignment retirement', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const survivorIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const loserIdentity = await createPassportIdentity(uniquePassportNumber(), '1990-02-02');
  assert.ok(survivorIdentity);
  assert.ok(loserIdentity);
  const { assignmentId, queueId } = await createVisaAssignmentWithQueue(groupId, loserIdentity.id, 'PENDING');

  try {
    await assert.rejects(() =>
      mergeIdentitiesTransaction({
        survivorId: survivorIdentity.id,
        loserId: loserIdentity.id,
        linkPlans: [],
        // A telegram_message_id that does not exist -- sheet_reconciliation_jobs'
        // own FK (migrations/0022_create_sheet_reconciliation_jobs.sql)
        // rejects this, forcing a genuine SQL error AFTER the new
        // retirement call (see mergeIdentitiesTransaction's own statement
        // order) but before COMMIT -- without touching any production
        // code to force it.
        staleSheetRows: [{ groupId, telegramMessageId: '00000000-0000-0000-0000-000000000000' }],
        operatorId: 'operator-1',
      }),
    );

    const loserAfter = await findPassportIdentityById(loserIdentity.id);
    assert.notEqual(loserAfter?.status, 'merged', 'the ENTIRE transaction must have rolled back, not just the failing statement');

    assert.equal(
      await getVisaAssignmentStatus(assignmentId),
      'active',
      'the visa assignment retirement (which succeeded earlier in the SAME transaction) must also be rolled back',
    );
    const queueState = await getQueueStatusAndConflict(queueId);
    assert.equal(queueState.status, 'PENDING');
  } finally {
    await cleanupAll([groupId], [agentId], [survivorIdentity.id, loserIdentity.id]);
  }
});
