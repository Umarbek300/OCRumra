import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { resolveAndLinkIdentity } from '../src/duplicates/resolveAndLinkIdentity.js';
import { findPassportIdentityByKey } from '../src/db/repositories/passportIdentity.repo.js';
import { findPassportMessageLinkByTelegramMessageId } from '../src/db/repositories/passportMessageLinks.repo.js';
import { findDuplicateReviewByCandidateMessageId, resolveDuplicateReview } from '../src/db/repositories/duplicateReviews.repo.js';
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

// ---------------------------------------------------------------------
// Package 0: identity_created transaction-atomicity + REVIEW stale-retry
// ---------------------------------------------------------------------

test('resolveAndLinkIdentity: two parallel callers racing to create the SAME new identity (different groups) never produce a duplicate identity_created event', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  const agentId = await createAgent();
  const messageA = await createMessage(groupA, agentId);
  const messageB = await createMessage(groupB, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    const [outcomeA, outcomeB] = await Promise.all([
      resolveAndLinkIdentity({
        telegramMessageId: messageA.telegramMessageId,
        groupId: groupA,
        agentId,
        passportNumber: { value: passportNumber, confidence: 'high' },
        dateOfBirth: { value: dob, confidence: 'high' },
      }),
      resolveAndLinkIdentity({
        telegramMessageId: messageB.telegramMessageId,
        groupId: groupB,
        agentId,
        passportNumber: { value: passportNumber, confidence: 'high' },
        dateOfBirth: { value: dob, confidence: 'high' },
      }),
    ]);

    assert.equal(outcomeA.kind, 'LINKED');
    assert.equal(outcomeB.kind, 'LINKED');
    if (outcomeA.kind !== 'LINKED' || outcomeB.kind !== 'LINKED') throw new Error('unreachable');
    assert.equal(outcomeA.identityId, outcomeB.identityId, 'both callers must converge on the SAME identity');

    const { rows: identityRows } = await pool.query(
      `SELECT id FROM passport_identity WHERE passport_number_normalized = $1 AND date_of_birth = $2`,
      [passportNumber, dob],
    );
    assert.equal(identityRows.length, 1, 'exactly one passport_identity row must exist, regardless of which caller won the race');

    const events = await listEventsForIdentity(outcomeA.identityId);
    const createdEvents = events.filter((e) => e.eventType === 'identity_created');
    assert.equal(createdEvents.length, 1, 'identity_created must be written exactly once, never by the losing caller');

    const linkedEvents = events.filter((e) => e.eventType === 'message_linked_canonical');
    assert.equal(linkedEvents.length, 2, 'each message still gets its own message_linked_canonical event');
  } finally {
    await cleanupAll([groupA, groupB], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity: an identity_created INSERT failure rolls back the identity row too -- no orphan identity, no event, no link', async () => {
  const realGroupId = await createGroup();
  const agentId = await createAgent();
  const message = await createMessage(realGroupId, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';
  // A syntactically valid but non-existent group id -- deliberately
  // chosen to violate passport_identity_events.group_id's FK to groups(id)
  // INSIDE findOrCreateIdentity's own transaction, forcing a real rollback
  // without any mock/dependency-injection (same technique already used by
  // "the database enforces uniqueness of personal_photo_token across rows"
  // in passportOcrResult.repo.test.ts).
  const nonExistentGroupId = randomUUID();

  try {
    await assert.rejects(
      () =>
        resolveAndLinkIdentity({
          telegramMessageId: message.telegramMessageId,
          groupId: nonExistentGroupId,
          agentId,
          passportNumber: { value: passportNumber, confidence: 'high' },
          dateOfBirth: { value: dob, confidence: 'high' },
        }),
      /violates foreign key constraint/,
    );

    const identity = await findPassportIdentityByKey(passportNumber, dob);
    assert.equal(identity, null, 'the identity row must be rolled back along with the failed event write -- never left orphaned');

    const link = await findPassportMessageLinkByTelegramMessageId(message.telegramMessageId);
    assert.equal(link, null, 'a failed identity+event transaction must never reach link creation');
  } finally {
    await cleanupAll([realGroupId], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity: identity_created is written only once, never again when a later message resolves to the same pre-existing identity', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  const agentId = await createAgent();
  const messageA = await createMessage(groupA, agentId);
  const messageB = await createMessage(groupB, agentId);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';

  try {
    const outcomeA = await resolveAndLinkIdentity({
      telegramMessageId: messageA.telegramMessageId,
      groupId: groupA,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });
    assert.equal(outcomeA.kind, 'LINKED');
    if (outcomeA.kind !== 'LINKED') throw new Error('unreachable');

    await resolveAndLinkIdentity({
      telegramMessageId: messageB.telegramMessageId,
      groupId: groupB,
      agentId,
      passportNumber: { value: passportNumber, confidence: 'high' },
      dateOfBirth: { value: dob, confidence: 'high' },
    });

    const events = await listEventsForIdentity(outcomeA.identityId);
    const createdEvents = events.filter((e) => e.eventType === 'identity_created');
    assert.equal(
      createdEvents.length,
      1,
      'the second message resolves via NEW_GROUP_RECORD, never re-entering NEW_IDENTITY -- identity_created must not repeat',
    );
  } finally {
    await cleanupAll([groupA, groupB], [agentId], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity: identity+identity_created commit even when the SUBSEQUENT link creation fails (safely recoverable on retry)', async () => {
  const groupId = await createGroup();
  const message = await createMessage(groupId, null);
  const passportNumber = uniquePassportNumber();
  const dob = '1990-01-01';
  // Deliberately non-existent agent id -- recordPassportIdentityEvent's own
  // input never includes agentId, so the identity+identity_created
  // transaction is unaffected and commits; only the LATER, separate
  // createPassportMessageLink call (which does use agentId) fails its own
  // FK, isolating exactly the "identity+event committed, link failed" case.
  const nonExistentAgentId = randomUUID();

  try {
    await assert.rejects(
      () =>
        resolveAndLinkIdentity({
          telegramMessageId: message.telegramMessageId,
          groupId,
          agentId: nonExistentAgentId,
          passportNumber: { value: passportNumber, confidence: 'high' },
          dateOfBirth: { value: dob, confidence: 'high' },
        }),
      /violates foreign key constraint/,
    );

    const identity = await findPassportIdentityByKey(passportNumber, dob);
    assert.ok(identity, 'the identity+identity_created transaction must already have committed before the link step ran');

    const events = await listEventsForIdentity(identity.id);
    assert.ok(
      events.some((e) => e.eventType === 'identity_created'),
      'identity_created must be committed despite the later link failure',
    );

    const link = await findPassportMessageLinkByTelegramMessageId(message.telegramMessageId);
    assert.equal(link, null, 'the link itself must not exist after its own creation failed');
  } finally {
    await cleanupAll([groupId], [], [{ passportNumber, dob }]);
  }
});

test('resolveAndLinkIdentity: a stale-job retry must never re-open an ALREADY-RESOLVED review', async () => {
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
    assert.deepEqual(first, { kind: 'REVIEW' });

    const pendingReview = await findDuplicateReviewByCandidateMessageId(messageB.telegramMessageId);
    assert.ok(pendingReview);
    const resolved = await resolveDuplicateReview(pendingReview.id, 'confirmed_distinct', 'test-operator');
    assert.ok(resolved, 'resolving the pending review must succeed');

    // Simulates performPassportOcr's own "OCR result already exists" retry
    // path (performPassportOcr.ts:160-173) calling resolveAndLinkIdentity
    // again for the SAME message -- e.g. after a stale passport_processing
    // job recovery -- long after the review was already decided.
    const second = await resolveAndLinkIdentity(input);
    assert.deepEqual(second, { kind: 'REVIEW' }, 'the retry must still report REVIEW (never silently proceed to link/merge), but without reopening it');

    const { rows } = await pool.query('SELECT id, status FROM duplicate_reviews WHERE candidate_telegram_message_id = $1', [
      messageB.telegramMessageId,
    ]);
    assert.equal(rows.length, 1, 'a stale retry must never create a second review row for an already-resolved candidate');
    assert.equal(rows[0]?.status, 'confirmed_distinct', 'the existing resolution must remain untouched');

    const events = await listEventsForIdentity(pendingReview.passportIdentityId);
    const reviewFlaggedEvents = events.filter((e) => e.eventType === 'review_flagged');
    assert.equal(reviewFlaggedEvents.length, 1, 'a stale retry must never write a second review_flagged event');
  } finally {
    await cleanupAll([groupId], [agentA, agentB], [{ passportNumber, dob }]);
  }
});
