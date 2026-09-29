import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { resolveAndLinkIdentity } from '../src/duplicates/resolveAndLinkIdentity.js';
import { findPassportIdentityByKey } from '../src/db/repositories/passportIdentity.repo.js';
import { findPassportMessageLinkByTelegramMessageId } from '../src/db/repositories/passportMessageLinks.repo.js';
import { findDuplicateReviewByCandidateMessageId } from '../src/db/repositories/duplicateReviews.repo.js';
import { listEventsForIdentity } from '../src/db/repositories/passportIdentityEvents.repo.js';

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
  return `RESOLVETEST${Date.now()}${idCounter}`;
}

async function createGroup(): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Resolve Identity Test Group', '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Resolve Identity Test Agent', uniqueUserId()],
  );
  assert.ok(agent);
  return agent.id;
}

async function createMessage(groupId: string, agentId: string | null): Promise<{ telegramMessageId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Resolve Identity Test Sender', now(), 'FILE_RESOLVE_TEST', $4, $5)
     RETURNING id`,
    [chatId, uniqueMessageId(), uniqueUserId(), groupId, agentId],
  );
  assert.ok(message);
  return { telegramMessageId: message.id, chatId };
}

/**
 * Order matters: duplicate_reviews/passport_identity_events reference
 * telegram_messages via plain (non-cascading) FKs -- correct for
 * production, where a telegram_messages row is NEVER physically deleted
 * (only passport_identity/link state transitions), so this constraint
 * never actually matters there. It only matters here, in test cleanup,
 * which is why every identity-linked row is torn down BEFORE the
 * telegram_messages rows they point at.
 */
async function cleanupAll(groupIds: string[], agentIds: string[], identityKeys: Array<{ passportNumber: string; dob: string }>) {
  const identityIds: string[] = [];
  for (const key of identityKeys) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM passport_identity WHERE passport_number_normalized = $1 AND date_of_birth = $2`,
      [key.passportNumber, key.dob],
    );
    if (rows[0]) identityIds.push(rows[0].id);
  }

  for (const identityId of identityIds) {
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
    await pool.query(`DELETE FROM passport_identity WHERE id = $1`, [identityId]);
  }
}

test('resolveAndLinkIdentity creates a NEW identity + canonical link + identity_created event for a brand-new passport', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const message = await createMessage(groupId, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    const outcome = await resolveAndLinkIdentity({
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    assert.equal(outcome.kind, 'LINKED');
    if (outcome.kind !== 'LINKED') throw new Error('unreachable');
    assert.equal(outcome.role, 'canonical');

    const identity = await findPassportIdentityByKey(passportNumber, dob);
    assert.ok(identity);
    assert.equal(identity.id, outcome.identityId);

    const link = await findPassportMessageLinkByTelegramMessageId(message.telegramMessageId);
    assert.equal(link?.role, 'canonical');
    assert.equal(link?.matchConfidenceTier, 'new_identity');

    const events = await listEventsForIdentity(identity.id);
    const eventTypes = events.map((e) => e.eventType);
    assert.ok(eventTypes.includes('identity_created'));
    assert.ok(eventTypes.includes('message_linked_canonical'));
  } finally {
    await cleanupAll([groupId], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity is idempotent -- calling it twice for the same message never creates a second link', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const message = await createMessage(groupId, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    const input = {
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' as const },
      dateOfBirth: { value: dob, confidence: 'high' as const },
    };
    const first = await resolveAndLinkIdentity(input);
    const second = await resolveAndLinkIdentity(input);

    assert.equal(first.kind, 'LINKED');
    assert.equal(second.kind, 'ALREADY_RESOLVED');

    const { rows } = await pool.query('SELECT id FROM passport_message_links WHERE telegram_message_id = $1', [
      message.telegramMessageId,
    ]);
    assert.equal(rows.length, 1);
  } finally {
    await cleanupAll([groupId], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity returns NO_IDENTITY_DATA and creates nothing when passport number is missing', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const message = await createMessage(groupId, agentId);

  try {
    const outcome = await resolveAndLinkIdentity({
      telegramMessageId: message.telegramMessageId,
      groupId,
      agentId,
      passportNumber: { value: null, confidence: null },
      dateOfBirth: { value: '1990-01-01', confidence: 'high' },
    });

    assert.deepEqual(outcome, { kind: 'NO_IDENTITY_DATA' });

    const link = await findPassportMessageLinkByTelegramMessageId(message.telegramMessageId);
    assert.equal(link, null);
  } finally {
    await cleanupAll([groupId], [agentId], []);
  }
});

test('resolveAndLinkIdentity creates a NEW_GROUP_RECORD (canonical link) when the same identity appears in a second group', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  const agentId = await createAgent();
  const messageA = await createMessage(groupA, agentId);
  const messageB = await createMessage(groupB, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    await resolveAndLinkIdentity({
      telegramMessageId: messageA.telegramMessageId,
      groupId: groupA,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    const outcomeB = await resolveAndLinkIdentity({
      telegramMessageId: messageB.telegramMessageId,
      groupId: groupB,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    assert.equal(outcomeB.kind, 'LINKED');
    if (outcomeB.kind !== 'LINKED') throw new Error('unreachable');
    assert.equal(outcomeB.role, 'canonical', 'a new group must get its own canonical, not become a duplicate of group A');

    const linkA = await findPassportMessageLinkByTelegramMessageId(messageA.telegramMessageId);
    const linkB = await findPassportMessageLinkByTelegramMessageId(messageB.telegramMessageId);
    assert.equal(linkA?.role, 'canonical', "group A's own link must be untouched");
    assert.equal(linkB?.role, 'canonical');
    assert.equal(linkA?.passportIdentityId, linkB?.passportIdentityId, 'both link to the SAME global identity');
  } finally {
    await cleanupAll([groupA, groupB], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity AUTO_MERGEs a second message: same passport, same group, same agent, HIGH/HIGH', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageA = await createMessage(groupId, agentId);
  const messageB = await createMessage(groupId, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    await resolveAndLinkIdentity({
      telegramMessageId: messageA.telegramMessageId,
      groupId,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    const outcomeB = await resolveAndLinkIdentity({
      telegramMessageId: messageB.telegramMessageId,
      groupId,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    assert.equal(outcomeB.kind, 'LINKED');
    if (outcomeB.kind !== 'LINKED') throw new Error('unreachable');
    assert.equal(outcomeB.role, 'duplicate');

    const linkA = await findPassportMessageLinkByTelegramMessageId(messageA.telegramMessageId);
    assert.equal(linkA?.role, 'canonical', 'the existing canonical must remain canonical -- no Sheet row created for the duplicate');
  } finally {
    await cleanupAll([groupId], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity returns REVIEW (agent_mismatch) and creates a pending review, no link', async () => {
  const groupId = await createGroup();
  const agentA = await createAgent();
  const agentB = await createAgent();
  const messageA = await createMessage(groupId, agentA);
  const messageB = await createMessage(groupId, agentB);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    await resolveAndLinkIdentity({
      telegramMessageId: messageA.telegramMessageId,
      groupId,
      agentId: agentA,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    const outcomeB = await resolveAndLinkIdentity({
      telegramMessageId: messageB.telegramMessageId,
      groupId,
      agentId: agentB,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    assert.deepEqual(outcomeB, { kind: 'REVIEW' });

    const linkB = await findPassportMessageLinkByTelegramMessageId(messageB.telegramMessageId);
    assert.equal(linkB, null, 'a REVIEW outcome must never create a link');

    const review = await findDuplicateReviewByCandidateMessageId(messageB.telegramMessageId);
    assert.equal(review?.status, 'pending');
    assert.equal(review?.reviewReason, 'agent_mismatch');
  } finally {
    await cleanupAll([groupId], [agentA, agentB], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity returns REVIEW (low_confidence_field) when DOB confidence is not HIGH, and creates no link', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageA = await createMessage(groupId, agentId);
  const messageB = await createMessage(groupId, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    await resolveAndLinkIdentity({
      telegramMessageId: messageA.telegramMessageId,
      groupId,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    const outcomeB = await resolveAndLinkIdentity({
      telegramMessageId: messageB.telegramMessageId,
      groupId,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'medium' },
    });

    assert.deepEqual(outcomeB, { kind: 'REVIEW' });

    const review = await findDuplicateReviewByCandidateMessageId(messageB.telegramMessageId);
    assert.equal(review?.reviewReason, 'low_confidence_field');
    assert.equal(review?.matchedAgainstTelegramMessageId, null, 'low_confidence_field never reaches the canonical-lookup step');
  } finally {
    await cleanupAll([groupId], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity does not create a duplicate review row when re-run while one is already pending', async () => {
  const groupId = await createGroup();
  const agentA = await createAgent();
  const agentB = await createAgent();
  const messageA = await createMessage(groupId, agentA);
  const messageB = await createMessage(groupId, agentB);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    await resolveAndLinkIdentity({
      telegramMessageId: messageA.telegramMessageId,
      groupId,
      agentId: agentA,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    const input = {
      telegramMessageId: messageB.telegramMessageId,
      groupId,
      agentId: agentB,
      passportNumber: { value: passportNumber, confidence: 'high' as const },
      dateOfBirth: { value: dob, confidence: 'high' as const },
    };
    const first = await resolveAndLinkIdentity(input);
    const second = await resolveAndLinkIdentity(input);

    assert.deepEqual(first, { kind: 'REVIEW' });
    assert.deepEqual(second, { kind: 'REVIEW' });

    const { rows } = await pool.query('SELECT id FROM duplicate_reviews WHERE candidate_telegram_message_id = $1', [
      messageB.telegramMessageId,
    ]);
    assert.equal(rows.length, 1, 'reprocessing must never create a second review row for the same message');
  } finally {
    await cleanupAll([groupId], [agentA, agentB], [{ passportNumber, dob }]);
  }
});
