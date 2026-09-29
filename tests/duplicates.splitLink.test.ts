import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportOcrResult } from '../src/db/repositories/passportOcrResult.repo.js';
import { createPassportIdentity, findPassportIdentityById } from '../src/db/repositories/passportIdentity.repo.js';
import {
  createPassportMessageLink,
  findActiveCanonicalLink,
  findPassportMessageLinkById,
} from '../src/db/repositories/passportMessageLinks.repo.js';
import { enqueueSheetSync, findSheetSyncQueueByTelegramMessageId, markSheetSyncStarted, markSheetSyncSynced } from '../src/db/repositories/sheetSyncQueue.repo.js';
import { listEventsForIdentity } from '../src/db/repositories/passportIdentityEvents.repo.js';
import { findReconciliationJobsForIdentityGroup } from '../src/db/repositories/sheetReconciliation.repo.js';
import { splitLink, type SplitLinkDependencies } from '../src/duplicates/splitLink.js';
import { findPassportOcrResultByTelegramMessageId } from '../src/db/repositories/passportOcrResult.repo.js';
import { findActiveDuplicateCandidates } from '../src/db/repositories/passportMessageLinks.repo.js';
import { applySplitTransaction } from '../src/duplicates/applyIdentityStateChange.js';
import { requeueSheetSyncForResync } from '../src/db/repositories/sheetSyncQueue.repo.js';

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
  return `SPLITTEST${Date.now()}${idCounter}`;
}

async function createGroup(): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Split Test Group', '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Split Test Agent', uniqueUserId()],
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
     ) VALUES ($1,$2,$3,'Split Test Sender', now(), 'FILE_SPLIT_TEST', $4, $5)
     RETURNING id`,
    [uniqueChatId(), uniqueMessageId(), uniqueUserId(), groupId, agentId],
  );
  assert.ok(message);
  return message.id;
}

async function createOcrResult(
  telegramMessageId: string,
  passportNumber: string = 'AB1234567',
  passportNumberConfidence: 'high' | 'medium' | 'low' = 'high',
  dobConfidence: 'high' | 'medium' | 'low' = 'high',
): Promise<void> {
  await createPassportOcrResult({
    telegramMessageId,
    firstName: { value: 'JOHN', confidence: 'high' },
    middleName: { value: null, confidence: null },
    surname: { value: 'DOE', confidence: 'high' },
    passportNumber: { value: passportNumber, confidence: passportNumberConfidence },
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

/**
 * identityIds MUST be passed child-first (a split-out identity before its
 * origin) — split_origin_identity_id is a plain FK with no ON DELETE
 * CASCADE, so a parent can't be deleted while a child still points at it.
 * Deliberately never clears split_origin_identity_id via UPDATE (unlike
 * merged_into_identity_id, which is safe to clear): doing so while both
 * rows still coexist would itself collide with
 * idx_passport_identity_key_unique, since that's exactly the constraint
 * split_origin_identity_id being NON-null is designed to bypass.
 */
async function cleanupAll(groupIds: string[], agentIds: string[], identityIds: string[]): Promise<void> {
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM sheet_reconciliation_jobs WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_message_links WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM duplicate_reviews WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_identity_events WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_operator_commands WHERE passport_identity_id = $1`, [identityId]);
  }
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM sheet_sync_queue WHERE telegram_message_id IN (SELECT id FROM telegram_messages WHERE group_id = $1)`, [
      groupId,
    ]);
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

function fakeDeps(overrides: Partial<SplitLinkDependencies> = {}): { deps: SplitLinkDependencies } {
  const deps: SplitLinkDependencies = {
    findLink: findPassportMessageLinkById,
    findIdentity: findPassportIdentityById,
    findOcrResult: findPassportOcrResultByTelegramMessageId,
    findActiveDuplicateCandidates,
    createIdentity: createPassportIdentity,
    applySplit: applySplitTransaction,
    requeueSheetSync: requeueSheetSyncForResync,
    enqueueSheetSync,
    ...overrides,
  };

  return { deps };
}

// --- (a) split canonical message, with a remaining duplicate to promote ---
test('(a) splitting a canonical message with a remaining duplicate promotes the duplicate in the original group and makes the split link canonical for its new identity', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const canonicalMessage = await createMessage(groupId, agentId);
  const duplicateMessage = await createMessage(groupId, agentId);
  await createOcrResult(canonicalMessage);
  await createOcrResult(duplicateMessage);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const canonicalLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: canonicalMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  const duplicateLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: duplicateMessage,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  assert.ok(canonicalLink);
  assert.ok(duplicateLink);

  let newIdentityId: string | undefined;
  try {
    const { deps } = fakeDeps();
    const result = await splitLink(canonicalLink.id, 'operator-1', deps);

    assert.equal(result.outcome, 'split');
    if (result.outcome !== 'split') throw new Error('unreachable');
    newIdentityId = result.newIdentityId;

    const splitOutLink = await findPassportMessageLinkById(canonicalLink.id);
    assert.equal(splitOutLink?.passportIdentityId, result.newIdentityId);
    assert.equal(splitOutLink?.role, 'canonical');
    assert.equal(splitOutLink?.linkStatus, 'active', 'link_status is never disturbed by a split');

    const newIdentity = await findPassportIdentityById(result.newIdentityId);
    assert.equal(newIdentity?.splitOriginIdentityId, identity.id);

    const promotedInOriginal = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(promotedInOriginal?.id, duplicateLink.id, 'the remaining duplicate becomes the original identity\'s new canonical');
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});

// --- (b) split a duplicate message ---
test('(b) splitting a duplicate message leaves the original identity\'s canonical completely untouched', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const canonicalMessage = await createMessage(groupId, agentId);
  const duplicateMessage = await createMessage(groupId, agentId);
  await createOcrResult(canonicalMessage);
  await createOcrResult(duplicateMessage);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const canonicalLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: canonicalMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  const duplicateLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: duplicateMessage,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  assert.ok(canonicalLink);
  assert.ok(duplicateLink);

  let newIdentityId: string | undefined;
  try {
    const { deps } = fakeDeps();
    const result = await splitLink(duplicateLink.id, 'operator-1', deps);

    assert.equal(result.outcome, 'split');
    if (result.outcome !== 'split') throw new Error('unreachable');
    newIdentityId = result.newIdentityId;

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 0, 'the original canonical is unaffected -- nothing to reconcile');

    const stillCanonical = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(stillCanonical?.id, canonicalLink.id);

    const splitOutLink = await findPassportMessageLinkById(duplicateLink.id);
    assert.equal(splitOutLink?.passportIdentityId, result.newIdentityId);
    assert.equal(splitOutLink?.role, 'canonical', 'always canonical for its own new identity, even though it was a duplicate before');
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});

// --- (c) split canonical message when multiple other duplicates remain ---
test('(c) splitting a canonical message with MULTIPLE remaining duplicates promotes the highest-scoring one', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const canonicalMessage = await createMessage(groupId, agentId);
  const weakDuplicateMessage = await createMessage(groupId, agentId);
  const strongDuplicateMessage = await createMessage(groupId, agentId);
  await createOcrResult(canonicalMessage);
  await createOcrResult(weakDuplicateMessage, 'AB1234567', 'medium', 'high');
  await createOcrResult(strongDuplicateMessage, 'AB1234567', 'high', 'high');
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const canonicalLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: canonicalMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  const weakLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: weakDuplicateMessage,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  const strongLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: strongDuplicateMessage,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  assert.ok(canonicalLink);
  assert.ok(weakLink);
  assert.ok(strongLink);

  let newIdentityId: string | undefined;
  try {
    const { deps } = fakeDeps();
    const result = await splitLink(canonicalLink.id, 'operator-1', deps);
    if (result.outcome === 'split') newIdentityId = result.newIdentityId;

    const newCanonical = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(newCanonical?.id, strongLink.id, 'the stronger-evidence duplicate wins the promotion');

    // The reconciliation job re-resolves the target fresh at PROCESSING
    // time (see reconcileSheetRow.ts), not at split time -- here we only
    // assert that the job is anchored at the ORIGINAL canonical message
    // (the thing to locate in the Sheet), not which replacement wins.
    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.expectedOldCanonicalTelegramMessageId, canonicalMessage);
    assert.equal(jobs[0]?.sourceOperation, 'split');
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});

// --- (d) split when the original identity loses its last active source ---
test('(d) splitting the ONLY link for an (identity, group) enqueues reconciliation to delete the original group\'s Sheet row', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const onlyMessage = await createMessage(groupId, agentId);
  await createOcrResult(onlyMessage);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const onlyLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: onlyMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(onlyLink);

  let newIdentityId: string | undefined;
  try {
    const { deps } = fakeDeps();
    const result = await splitLink(onlyLink.id, 'operator-1', deps);
    if (result.outcome === 'split') newIdentityId = result.newIdentityId;

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.expectedOldCanonicalTelegramMessageId, onlyMessage);
    assert.equal(jobs[0]?.sourceOperation, 'split');

    const remainingCanonical = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(remainingCanonical, null, 'the original identity has no remaining active source in this group');

    if (result.outcome !== 'split') throw new Error('unreachable');
    const newCanonical = await findActiveCanonicalLink(result.newIdentityId, groupId);
    assert.equal(newCanonical?.telegramMessageId, onlyMessage, 'the split-out identity owns the message as its own canonical instead');
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});

// --- (e) Sheet synchronization ---
test('(e) split routes the new identity\'s own canonical through the NORMAL sheet_sync_queue pipeline (requeue), not a direct Sheets call', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const message = await createMessage(groupId, agentId);
  await createOcrResult(message);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: message,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  // Simulate this message already having a 'synced' sheet_sync_queue job (as it would in practice, from Phase C's enqueue after OCR).
  const job = await enqueueSheetSync(message);
  assert.ok(job);
  const claimed = await markSheetSyncStarted(job.id);
  assert.ok(claimed);
  await markSheetSyncSynced(claimed.id, 2);

  let newIdentityId: string | undefined;
  try {
    const { deps } = fakeDeps();
    const result = await splitLink(link.id, 'operator-1', deps);
    if (result.outcome === 'split') newIdentityId = result.newIdentityId;

    const jobAfterSplit = await findSheetSyncQueueByTelegramMessageId(message);
    assert.equal(jobAfterSplit?.status, 'pending', 'requeued through the normal pipeline, not written to directly');
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});

test('(e) split falls back to enqueueSheetSync when no job exists yet for the split-out message', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const message = await createMessage(groupId, agentId);
  await createOcrResult(message);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: message,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  let newIdentityId: string | undefined;
  try {
    const { deps } = fakeDeps();
    const result = await splitLink(link.id, 'operator-1', deps);
    if (result.outcome === 'split') newIdentityId = result.newIdentityId;

    const job = await findSheetSyncQueueByTelegramMessageId(message);
    assert.equal(job?.status, 'pending');
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});

// --- (f) repeated identical split command ---
test('(f) splitting the same link twice is idempotent -- the second call is a no-op returning the same new identity', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const message = await createMessage(groupId, agentId);
  await createOcrResult(message);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: message,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  let newIdentityId: string | undefined;
  try {
    const { deps: deps1 } = fakeDeps();
    const first = await splitLink(link.id, 'operator-1', deps1);
    assert.equal(first.outcome, 'split');
    if (first.outcome !== 'split') throw new Error('unreachable');
    newIdentityId = first.newIdentityId;

    const { deps: deps2 } = fakeDeps();
    const second = await splitLink(link.id, 'operator-1', deps2);

    assert.equal(second.outcome, 'already_split');
    if (second.outcome !== 'already_split') throw new Error('unreachable');
    assert.equal(second.newIdentityId, first.newIdentityId, 'no second identity is created');

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1, 'the idempotent no-op enqueues no second reconciliation job');

    const events = await listEventsForIdentity(identity.id);
    assert.equal(events.filter((e) => e.eventType === 'identity_split').length, 1, 'exactly one identity_split event, never two');
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});
