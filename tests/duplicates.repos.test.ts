import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportOcrResult } from '../src/db/repositories/passportOcrResult.repo.js';
import {
  createPassportIdentity,
  findPassportIdentityByKey,
  findPassportIdentityById,
  setPassportIdentityStatus,
} from '../src/db/repositories/passportIdentity.repo.js';
import {
  createPassportMessageLink,
  findActiveCanonicalLink,
  findActiveCanonicalLinksForGroup,
  findActiveDuplicateCandidates,
  findAllLinksForIdentity,
  findPassportMessageLinkByTelegramMessageId,
  reassignLinkToIdentity,
  setPassportMessageLinkRole,
  setPassportMessageLinkStatus,
} from '../src/db/repositories/passportMessageLinks.repo.js';
import {
  createDuplicateReview,
  findDuplicateReviewById,
  listPendingDuplicateReviews,
  resolveDuplicateReview,
} from '../src/db/repositories/duplicateReviews.repo.js';
import { listEventsForIdentity, recordPassportIdentityEvent } from '../src/db/repositories/passportIdentityEvents.repo.js';
import {
  claimPassportOperatorCommand,
  createCancelOrRemoveCommand,
  createMoveToGroupCommand,
  markPassportOperatorCommandCompleted,
  markPassportOperatorCommandFailed,
  recoverStaleOperatorCommands,
} from '../src/db/repositories/passportOperatorCommands.repo.js';

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
  return `DUPTEST${Date.now()}${idCounter}`;
}

interface GroupFixture {
  groupId: string;
  chatId: number;
}

async function createGroup(): Promise<GroupFixture> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Duplicate Test Group', '2026-09-20', chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Duplicate Test Agent', uniqueUserId()],
  );
  assert.ok(agent);
  return agent.id;
}

interface MessageFixture {
  telegramMessageId: string;
  groupId: string;
  agentId: string | null;
  chatId: number;
}

async function createLinkedTelegramMessage(groupId: string, agentId: string | null): Promise<MessageFixture> {
  const chatId = uniqueChatId();
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Duplicate Test Sender', now(), 'FILE_DUP_TEST', $4, $5)
     RETURNING id`,
    [chatId, uniqueMessageId(), uniqueUserId(), groupId, agentId],
  );
  assert.ok(message);
  return { telegramMessageId: message.id, groupId, agentId, chatId };
}

async function createOcrResultForMessage(
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

async function cleanupGroups(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(
      `DELETE FROM telegram_messages WHERE group_id = $1`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

async function cleanupAgents(agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
  }
}

/**
 * Self-contained: removes every row that could still reference this
 * identity via a plain (non-cascading) FK -- passport_message_links,
 * duplicate_reviews, passport_identity_events, passport_operator_commands
 * -- before deleting the identity row itself, regardless of whether
 * cleanupGroups has already run (its telegram_messages cascade only
 * removes links tied to THAT group's messages, not e.g. a link reassigned
 * to a different identity in the merge test).
 */
async function cleanupIdentity(identityId: string): Promise<void> {
  await pool.query(`DELETE FROM passport_message_links WHERE passport_identity_id = $1`, [identityId]);
  await pool.query(`DELETE FROM duplicate_reviews WHERE passport_identity_id = $1`, [identityId]);
  await pool.query(`DELETE FROM passport_identity_events WHERE passport_identity_id = $1`, [identityId]);
  await pool.query(`DELETE FROM passport_operator_commands WHERE passport_identity_id = $1`, [identityId]);
  await pool.query(`UPDATE passport_identity SET merged_into_identity_id = NULL WHERE merged_into_identity_id = $1`, [identityId]);
  await pool.query(`DELETE FROM passport_identity WHERE id = $1`, [identityId]);
}

// --- passportIdentity.repo.ts ---

test('createPassportIdentity creates a new identity and findPassportIdentityByKey finds it', async () => {
  const passportNumber = uniquePassportNumber();
  const identity = await createPassportIdentity(passportNumber, '1990-01-01');
  assert.ok(identity);
  try {
    assert.equal(identity.status, 'active');
    assert.equal(identity.mergedIntoIdentityId, null);

    const found = await findPassportIdentityByKey(passportNumber, '1990-01-01');
    assert.equal(found?.id, identity.id);
  } finally {
    await cleanupIdentity(identity.id);
  }
});

test('createPassportIdentity is idempotent -- UNIQUE(passport_number_normalized, date_of_birth) via ON CONFLICT DO NOTHING', async () => {
  const passportNumber = uniquePassportNumber();
  const first = await createPassportIdentity(passportNumber, '1990-01-01');
  assert.ok(first);
  try {
    const second = await createPassportIdentity(passportNumber, '1990-01-01');
    assert.equal(second, null);

    const { rows } = await pool.query('SELECT id FROM passport_identity WHERE passport_number_normalized = $1', [passportNumber]);
    assert.equal(rows.length, 1);
  } finally {
    await cleanupIdentity(first.id);
  }
});

test('a different date_of_birth with the same passport number creates a DIFFERENT identity', async () => {
  const passportNumber = uniquePassportNumber();
  const first = await createPassportIdentity(passportNumber, '1990-01-01');
  const second = await createPassportIdentity(passportNumber, '1991-01-01');
  assert.ok(first);
  assert.ok(second);
  try {
    assert.notEqual(first.id, second.id);
  } finally {
    await cleanupIdentity(first.id);
    await cleanupIdentity(second.id);
  }
});

test('setPassportIdentityStatus transitions status without physically deleting the row', async () => {
  const passportNumber = uniquePassportNumber();
  const identity = await createPassportIdentity(passportNumber, '1990-01-01');
  assert.ok(identity);
  try {
    const archived = await setPassportIdentityStatus(identity.id, 'archived_source_deleted');
    assert.equal(archived?.status, 'archived_source_deleted');

    const stillExists = await findPassportIdentityById(identity.id);
    assert.ok(stillExists, 'row must still exist after a status transition');
    assert.equal(stillExists.status, 'archived_source_deleted');
  } finally {
    await cleanupIdentity(identity.id);
  }
});

test('setPassportIdentityStatus can set merged_into_identity_id when transitioning to merged', async () => {
  const survivor = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const loser = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(survivor);
  assert.ok(loser);
  try {
    const merged = await setPassportIdentityStatus(loser.id, 'merged', survivor.id);
    assert.equal(merged?.status, 'merged');
    assert.equal(merged?.mergedIntoIdentityId, survivor.id);
  } finally {
    await cleanupIdentity(loser.id);
    await cleanupIdentity(survivor.id);
  }
});

// --- passportMessageLinks.repo.ts ---

test('createPassportMessageLink creates a canonical link and findActiveCanonicalLink finds it', async () => {
  const { groupId, chatId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const message = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const link = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(link);
    assert.equal(link.role, 'canonical');
    assert.equal(link.linkStatus, 'active');

    const found = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(found?.id, link.id);

    const byMessage = await findPassportMessageLinkByTelegramMessageId(message.telegramMessageId);
    assert.equal(byMessage?.id, link.id);
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('findActiveCanonicalLinksForGroup lists every active canonical in a group, excludes duplicates/cancelled/removed/other groups', async () => {
  const { groupId } = await createGroup();
  const { groupId: otherGroupId } = await createGroup();
  const agentId = await createAgent();

  const identityA = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const identityB = await createPassportIdentity(uniquePassportNumber(), '1991-02-02');
  const identityC = await createPassportIdentity(uniquePassportNumber(), '1992-03-03');
  const identityD = await createPassportIdentity(uniquePassportNumber(), '1993-04-04');
  const identityOther = await createPassportIdentity(uniquePassportNumber(), '1994-05-05');
  assert.ok(identityA && identityB && identityC && identityD && identityOther);

  const messageA = await createLinkedTelegramMessage(groupId, agentId);
  const messageBCanonical = await createLinkedTelegramMessage(groupId, agentId);
  const messageBDuplicate = await createLinkedTelegramMessage(groupId, agentId);
  const messageC = await createLinkedTelegramMessage(groupId, agentId);
  const messageD = await createLinkedTelegramMessage(groupId, agentId);
  const messageOther = await createLinkedTelegramMessage(otherGroupId, agentId);

  try {
    // A: one ordinary active canonical -- must be included.
    const linkA = await createPassportMessageLink({
      passportIdentityId: identityA.id,
      telegramMessageId: messageA.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(linkA);

    // B: an active canonical PLUS an active duplicate for the same identity
    // -- only the canonical one must appear, never the duplicate.
    const linkBCanonical = await createPassportMessageLink({
      passportIdentityId: identityB.id,
      telegramMessageId: messageBCanonical.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(linkBCanonical);
    const linkBDuplicate = await createPassportMessageLink({
      passportIdentityId: identityB.id,
      telegramMessageId: messageBDuplicate.telegramMessageId,
      groupId,
      agentId,
      role: 'duplicate',
      matchConfidenceTier: 'high',
    });
    assert.ok(linkBDuplicate);

    // C: a cancelled canonical -- must be excluded entirely.
    const linkC = await createPassportMessageLink({
      passportIdentityId: identityC.id,
      telegramMessageId: messageC.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(linkC);
    await setPassportMessageLinkStatus(linkC.id, 'cancelled');

    // D: a removed canonical -- must be excluded entirely.
    const linkD = await createPassportMessageLink({
      passportIdentityId: identityD.id,
      telegramMessageId: messageD.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(linkD);
    await setPassportMessageLinkStatus(linkD.id, 'removed');

    // Other: an active canonical in a DIFFERENT group -- must never leak in.
    const linkOther = await createPassportMessageLink({
      passportIdentityId: identityOther.id,
      telegramMessageId: messageOther.telegramMessageId,
      groupId: otherGroupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(linkOther);

    const results = await findActiveCanonicalLinksForGroup(groupId);
    const resultIds = results.map((link) => link.id).sort();
    assert.deepEqual(resultIds, [linkA.id, linkBCanonical.id].sort());
  } finally {
    await cleanupIdentity(identityA.id);
    await cleanupIdentity(identityB.id);
    await cleanupIdentity(identityC.id);
    await cleanupIdentity(identityD.id);
    await cleanupIdentity(identityOther.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId, otherGroupId]);
  }
});

test('findActiveCanonicalLinksForGroup returns an empty array for a group with no applicants', async () => {
  const { groupId } = await createGroup();
  try {
    const results = await findActiveCanonicalLinksForGroup(groupId);
    assert.deepEqual(results, []);
  } finally {
    await cleanupGroups([groupId]);
  }
});

test('createPassportMessageLink is idempotent -- UNIQUE(telegram_message_id) via ON CONFLICT DO NOTHING', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const message = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const first = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(first);

    const second = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      role: 'duplicate',
      matchConfidenceTier: 'high',
    });
    assert.equal(second, null);
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('the partial unique index prevents two active canonical links for the same (identity, group)', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const messageA = await createLinkedTelegramMessage(groupId, agentId);
  const messageB = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const linkA = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: messageA.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(linkA);

    await assert.rejects(
      createPassportMessageLink({
        passportIdentityId: identity.id,
        telegramMessageId: messageB.telegramMessageId,
        groupId,
        agentId,
        role: 'canonical',
        matchConfidenceTier: 'high',
      }),
      /duplicate key value violates unique constraint/,
    );
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('after the canonical link is cancelled, a new canonical CAN be created for the same (identity, group)', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const messageA = await createLinkedTelegramMessage(groupId, agentId);
  const messageB = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const linkA = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: messageA.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(linkA);
    await setPassportMessageLinkStatus(linkA.id, 'cancelled');

    const linkB = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: messageB.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'high',
    });
    assert.ok(linkB, 'a new canonical must be creatable once the old one is no longer active');

    const activeCanonical = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(activeCanonical?.id, linkB.id);
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('findActiveDuplicateCandidates returns only active duplicate links with their OCR confidence and message timestamp', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const canonicalMessage = await createLinkedTelegramMessage(groupId, agentId);
  const duplicateMessage = await createLinkedTelegramMessage(groupId, agentId);
  const cancelledMessage = await createLinkedTelegramMessage(groupId, agentId);

  await createOcrResultForMessage(canonicalMessage.telegramMessageId);
  await createOcrResultForMessage(duplicateMessage.telegramMessageId, 'high', 'medium');
  await createOcrResultForMessage(cancelledMessage.telegramMessageId);

  try {
    await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: canonicalMessage.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    const duplicateLink = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: duplicateMessage.telegramMessageId,
      groupId,
      agentId,
      role: 'duplicate',
      matchConfidenceTier: 'high',
    });
    const cancelledLink = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: cancelledMessage.telegramMessageId,
      groupId,
      agentId,
      role: 'duplicate',
      matchConfidenceTier: 'high',
    });
    assert.ok(duplicateLink);
    assert.ok(cancelledLink);
    await setPassportMessageLinkStatus(cancelledLink.id, 'cancelled');

    const candidates = await findActiveDuplicateCandidates(identity.id, groupId);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.linkId, duplicateLink.id);
    assert.equal(candidates[0]?.dobConfidence, 'medium');
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('setPassportMessageLinkRole flips a link between canonical and duplicate', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const message = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const link = await createPassportMessageLink({
      passportIdentityId: identity.id,
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(link);
    const updated = await setPassportMessageLinkRole(link.id, 'duplicate');
    assert.equal(updated?.role, 'duplicate');
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('reassignLinkToIdentity re-points a link at a different identity (used only by identity-merge)', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identityA = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  const identityB = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identityA);
  assert.ok(identityB);
  const message = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const link = await createPassportMessageLink({
      passportIdentityId: identityA.id,
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      role: 'canonical',
      matchConfidenceTier: 'new_identity',
    });
    assert.ok(link);
    const reassigned = await reassignLinkToIdentity(link.id, identityB.id);
    assert.equal(reassigned?.passportIdentityId, identityB.id);

    const linksForB = await findAllLinksForIdentity(identityB.id);
    assert.equal(linksForB.length, 1);
    assert.equal(linksForB[0]?.id, link.id);
  } finally {
    await cleanupIdentity(identityA.id);
    await cleanupIdentity(identityB.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

// --- duplicateReviews.repo.ts ---

test('createDuplicateReview flags a candidate and listPendingDuplicateReviews finds it', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const message = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const review = await createDuplicateReview({
      passportIdentityId: identity.id,
      candidateTelegramMessageId: message.telegramMessageId,
      matchedAgainstTelegramMessageId: null,
      reviewReason: 'agent_mismatch',
    });
    assert.ok(review);
    assert.equal(review.status, 'pending');

    const pending = await listPendingDuplicateReviews();
    assert.ok(pending.some((r) => r.id === review.id));

    const found = await findDuplicateReviewById(review.id);
    assert.equal(found?.id, review.id);
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('createDuplicateReview refuses a second open review for the same candidate message', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const message = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const first = await createDuplicateReview({
      passportIdentityId: identity.id,
      candidateTelegramMessageId: message.telegramMessageId,
      matchedAgainstTelegramMessageId: null,
      reviewReason: 'agent_mismatch',
    });
    assert.ok(first);

    const second = await createDuplicateReview({
      passportIdentityId: identity.id,
      candidateTelegramMessageId: message.telegramMessageId,
      matchedAgainstTelegramMessageId: null,
      reviewReason: 'low_confidence_field',
    });
    assert.equal(second, null);
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

test('resolveDuplicateReview is idempotent -- resolving an already-resolved review a second time is a no-op', async () => {
  const { groupId } = await createGroup();
  const agentId = await createAgent();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const message = await createLinkedTelegramMessage(groupId, agentId);

  try {
    const review = await createDuplicateReview({
      passportIdentityId: identity.id,
      candidateTelegramMessageId: message.telegramMessageId,
      matchedAgainstTelegramMessageId: null,
      reviewReason: 'agent_mismatch',
    });
    assert.ok(review);

    const firstResolve = await resolveDuplicateReview(review.id, 'confirmed_duplicate', 'operator-1');
    assert.equal(firstResolve?.status, 'confirmed_duplicate');

    const secondResolve = await resolveDuplicateReview(review.id, 'confirmed_distinct', 'operator-2');
    assert.equal(secondResolve, null, 'resolving twice must be a no-op, never overwriting the first resolution');

    const finalState = await findDuplicateReviewById(review.id);
    assert.equal(finalState?.status, 'confirmed_duplicate', 'the original resolution must stick');
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupAgents([agentId]);
    await cleanupGroups([groupId]);
  }
});

// --- passportIdentityEvents.repo.ts ---

test('recordPassportIdentityEvent appends an event and listEventsForIdentity returns it', async () => {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    const event = await recordPassportIdentityEvent({
      passportIdentityId: identity.id,
      eventType: 'identity_created',
      actor: 'system',
      detail: 'created via test',
    });
    assert.ok(event);

    const events = await listEventsForIdentity(identity.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'identity_created');
    assert.equal(events[0]?.actor, 'system');
  } finally {
    await cleanupIdentity(identity.id);
  }
});

test('recordPassportIdentityEvent bounds an overlong detail string rather than storing it unbounded', async () => {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    const longDetail = 'x'.repeat(1000);
    const event = await recordPassportIdentityEvent({
      passportIdentityId: identity.id,
      eventType: 'identity_created',
      actor: 'system',
      detail: longDetail,
    });
    assert.ok((event.detail?.length ?? 0) <= 300);
  } finally {
    await cleanupIdentity(identity.id);
  }
});

// --- passportOperatorCommands.repo.ts ---

test('createCancelOrRemoveCommand creates a pending command, claim/complete flow works', async () => {
  const { groupId } = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: null,
      operatorId: 'operator-1',
    });
    assert.equal(command.status, 'pending');
    assert.equal(command.attempts, 0);

    const claimed = await claimPassportOperatorCommand(command.id);
    assert.equal(claimed?.status, 'processing');
    assert.equal(claimed?.attempts, 1);

    const secondClaim = await claimPassportOperatorCommand(command.id);
    assert.equal(secondClaim, null, 'a command already claimed must not be claimable again');

    const completed = await markPassportOperatorCommandCompleted(command.id);
    assert.equal(completed?.status, 'completed');
    assert.ok(completed?.completedAt);
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupGroups([groupId]);
  }
});

test('createMoveToGroupCommand stores both from/to group ids and is claimable/failable', async () => {
  const { groupId: fromGroupId } = await createGroup();
  const { groupId: toGroupId } = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    const command = await createMoveToGroupCommand({
      passportIdentityId: identity.id,
      fromGroupId,
      toGroupId,
      telegramMessageId: null,
      operatorId: 'operator-1',
    });
    assert.equal(command.commandType, 'move_to_group');
    assert.equal(command.fromGroupId, fromGroupId);
    assert.equal(command.toGroupId, toGroupId);
    assert.equal(command.groupId, null);

    await claimPassportOperatorCommand(command.id);
    const failed = await markPassportOperatorCommandFailed(command.id, 'simulated failure for test');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lastError, 'simulated failure for test');
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupGroups([fromGroupId, toGroupId]);
  }
});

test('the shape CHECK constraint rejects a cancel_passport command with from/to group ids set', async () => {
  const { groupId } = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO passport_operator_commands (command_type, passport_identity_id, group_id, from_group_id, to_group_id, operator_id)
         VALUES ('cancel_passport', $1, $2, $2, $2, 'operator-1')`,
        [identity.id, groupId],
      ),
      /violates check constraint/,
    );
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupGroups([groupId]);
  }
});

test('recoverStaleOperatorCommands requeues a command stuck in processing past the timeout', async () => {
  const { groupId } = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'remove_from_group',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: null,
      operatorId: 'operator-1',
    });
    await claimPassportOperatorCommand(command.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`UPDATE passport_operator_commands SET updated_at = now() - interval '20 minutes' WHERE id = $1`, [
        command.id,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const { requeued, failed } = await recoverStaleOperatorCommands(10, 3);
    assert.ok(requeued.some((c) => c.id === command.id));
    assert.equal(failed.length, 0);
  } finally {
    await cleanupIdentity(identity.id);
    await cleanupGroups([groupId]);
  }
});
