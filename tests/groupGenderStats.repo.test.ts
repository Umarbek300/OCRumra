import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { computeGroupGenderStats } from '../src/db/repositories/groupGenderStats.repo.js';
import { createPassportOcrResult, type CreatePassportOcrResultInput, type OcrGenderValue } from '../src/db/repositories/passportOcrResult.repo.js';

// This exercises computeGroupGenderStats's real SQL (the join through
// telegram_messages.group_id + the GROUP BY on passport_ocr_results.gender)
// against a real Postgres instance -- the same "one file per repo function
// gets a real-DB test" convention as passportOcrResult.repo.test.ts and
// sheetSyncQueue.repo.test.ts.

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniqueMessageId(): number {
  idCounter += 1;
  return idCounter;
}
function uniqueSenderId(): number {
  idCounter += 1;
  return Date.now() * 1000 + idCounter;
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
    ['Gender Stats Test Group', '2026-09-20', chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

function sampleOcrInput(telegramMessageId: string, gender: OcrGenderValue | null): CreatePassportOcrResultInput {
  return {
    telegramMessageId,
    firstName: { value: 'A', confidence: 'high' },
    middleName: { value: null, confidence: null },
    surname: { value: 'B', confidence: 'high' },
    passportNumber: { value: 'X0000000', confidence: 'high' },
    dateOfBirth: { value: '1990-01-01', confidence: 'high' },
    passportIssueDate: { value: '2020-01-01', confidence: 'high' },
    passportExpiryDate: { value: '2030-01-01', confidence: 'high' },
    gender: { value: gender, confidence: gender ? 'high' : null },
    nationality: { value: 'UZB', confidence: 'medium' },
    placeOfBirth: { value: null, confidence: null },
    issuingAuthority: { value: null, confidence: null },
    mrz: { value: null, confidence: null },
    overallConfidence: 'high',
    rawResponse: {},
    provider: 'google-vision',
    model: 'google-vision-mrz',
  };
}

/** Adds one passenger (a telegram_message + its passport_ocr_results row) to a group, with the given gender. */
async function addPassenger(fixture: GroupFixture, gender: OcrGenderValue | null): Promise<string> {
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id
     ) VALUES ($1,$2,$3,'Gender Stats Test', now(), 'FILE_GENDER_STATS_TEST', $4)
     RETURNING id`,
    [fixture.chatId, uniqueMessageId(), uniqueSenderId(), fixture.groupId],
  );
  assert.ok(message);

  const result = await createPassportOcrResult(sampleOcrInput(message.id, gender));
  assert.ok(result, 'expected a fresh insert to succeed (unique telegram_message_id)');
  return message.id;
}

async function cleanupGroup(fixture: GroupFixture): Promise<void> {
  await pool.query('DELETE FROM telegram_messages WHERE telegram_chat_id = $1', [fixture.chatId]);
  await pool.query('DELETE FROM groups WHERE id = $1', [fixture.groupId]);
}

test('computeGroupGenderStats counts male, female, and unspecified correctly, with total = male + female + unspecified', async () => {
  const fixture = await createGroup();
  try {
    await addPassenger(fixture, 'male');
    await addPassenger(fixture, 'male');
    await addPassenger(fixture, 'male');
    await addPassenger(fixture, 'female');
    await addPassenger(fixture, 'female');
    await addPassenger(fixture, 'unspecified');

    const stats = await computeGroupGenderStats(fixture.groupId);
    assert.equal(stats.male, 3);
    assert.equal(stats.female, 2);
    assert.equal(stats.unspecified, 1);
    assert.equal(stats.total, 6);
    assert.equal(stats.male + stats.female + stats.unspecified, stats.total);
  } finally {
    await cleanupGroup(fixture);
  }
});

test('computeGroupGenderStats folds a NULL gender (nothing detected at all) into unspecified, never into male or female', async () => {
  const fixture = await createGroup();
  try {
    await addPassenger(fixture, null);
    await addPassenger(fixture, 'male');

    const stats = await computeGroupGenderStats(fixture.groupId);
    assert.equal(stats.male, 1);
    assert.equal(stats.female, 0);
    assert.equal(stats.unspecified, 1);
    assert.equal(stats.total, 2);
  } finally {
    await cleanupGroup(fixture);
  }
});

test('computeGroupGenderStats returns all zeros for a group with no linked passport results yet', async () => {
  const fixture = await createGroup();
  try {
    const stats = await computeGroupGenderStats(fixture.groupId);
    assert.deepEqual(stats, { male: 0, female: 0, unspecified: 0, total: 0 });
  } finally {
    await cleanupGroup(fixture);
  }
});

test('computeGroupGenderStats never counts a passenger belonging to a DIFFERENT group', async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    await addPassenger(groupA, 'male');
    await addPassenger(groupB, 'female');

    const statsA = await computeGroupGenderStats(groupA.groupId);
    const statsB = await computeGroupGenderStats(groupB.groupId);

    assert.deepEqual(statsA, { male: 1, female: 0, unspecified: 0, total: 1 });
    assert.deepEqual(statsB, { male: 0, female: 1, unspecified: 0, total: 1 });
  } finally {
    await cleanupGroup(groupA);
    await cleanupGroup(groupB);
  }
});

test('computeGroupGenderStats called twice in a row (simulating a sheet-sync retry) never double-counts — identical live totals both times', async () => {
  const fixture = await createGroup();
  try {
    await addPassenger(fixture, 'male');
    await addPassenger(fixture, 'female');

    const first = await computeGroupGenderStats(fixture.groupId);
    const second = await computeGroupGenderStats(fixture.groupId);

    assert.deepEqual(first, second);
    assert.deepEqual(first, { male: 1, female: 1, unspecified: 0, total: 2 });
  } finally {
    await cleanupGroup(fixture);
  }
});

test('a duplicate Telegram message, blocked by telegram_messages own UNIQUE(telegram_chat_id, telegram_message_id) constraint, never inflates the count', async () => {
  const fixture = await createGroup();
  try {
    const messageId = uniqueMessageId();
    const {
      rows: [message],
    } = await pool.query<{ id: string }>(
      `INSERT INTO telegram_messages (
         telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
         message_timestamp, telegram_photo_file_id, group_id
       ) VALUES ($1,$2,$3,'Gender Stats Test', now(), 'FILE_GENDER_STATS_TEST', $4)
       ON CONFLICT (telegram_chat_id, telegram_message_id) DO NOTHING
       RETURNING id`,
      [fixture.chatId, messageId, uniqueSenderId(), fixture.groupId],
    );
    assert.ok(message);
    await createPassportOcrResult(sampleOcrInput(message.id, 'male'));

    // Simulate Telegram redelivering the exact same (chat_id, message_id) --
    // the real recordPhotoMessage path's own duplicate guard (see
    // telegramMessages.repo.ts), reproduced directly here.
    const duplicateInsert = await pool.query<{ id: string }>(
      `INSERT INTO telegram_messages (
         telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
         message_timestamp, telegram_photo_file_id, group_id
       ) VALUES ($1,$2,$3,'Gender Stats Test', now(), 'FILE_GENDER_STATS_TEST', $4)
       ON CONFLICT (telegram_chat_id, telegram_message_id) DO NOTHING
       RETURNING id`,
      [fixture.chatId, messageId, uniqueSenderId(), fixture.groupId],
    );
    assert.equal(duplicateInsert.rows.length, 0, 'the duplicate insert must be a no-op -- confirms the guard this test relies on');

    const stats = await computeGroupGenderStats(fixture.groupId);
    assert.equal(stats.male, 1, 'still exactly one, never two');
    assert.equal(stats.total, 1);
  } finally {
    await cleanupGroup(fixture);
  }
});

/** Adds one passenger AND its passport_message_links row, so tests can exercise role/link_status filtering. */
async function addLinkedPassenger(
  fixture: GroupFixture,
  gender: OcrGenderValue | null,
  role: 'canonical' | 'duplicate',
  linkStatus: 'active' | 'cancelled' | 'removed' | 'moved',
  linkGroupId: string = fixture.groupId,
): Promise<{ messageId: string; identityId: string }> {
  const messageId = await addPassenger(fixture, gender);
  const {
    rows: [identity],
  } = await pool.query<{ id: string }>(
    `INSERT INTO passport_identity (passport_number_normalized, date_of_birth) VALUES ($1, $2) RETURNING id`,
    [`GENDERSTATS-${messageId}`, '1990-01-01'],
  );
  assert.ok(identity);
  await pool.query(
    `INSERT INTO passport_message_links (passport_identity_id, telegram_message_id, group_id, agent_id, role, link_status, match_confidence_tier)
     VALUES ($1, $2, $3, NULL, $4, $5, 'high')`,
    [identity.id, messageId, linkGroupId, role, linkStatus],
  );
  return { messageId, identityId: identity.id };
}

test('computeGroupGenderStats never counts a role=duplicate link (an auto-merged repeat send within the same group)', async () => {
  const fixture = await createGroup();
  try {
    await addLinkedPassenger(fixture, 'male', 'canonical', 'active');
    await addLinkedPassenger(fixture, 'male', 'duplicate', 'active');
    await addLinkedPassenger(fixture, 'male', 'duplicate', 'active');

    const stats = await computeGroupGenderStats(fixture.groupId);
    assert.equal(stats.male, 1, 'only the canonical link counts -- the two duplicate sends must not inflate the total');
    assert.equal(stats.total, 1);
  } finally {
    await cleanupGroup(fixture);
  }
});

test('computeGroupGenderStats never counts a cancelled or removed link', async () => {
  const fixture = await createGroup();
  try {
    await addLinkedPassenger(fixture, 'male', 'canonical', 'active');
    await addLinkedPassenger(fixture, 'female', 'canonical', 'cancelled');
    await addLinkedPassenger(fixture, 'female', 'canonical', 'removed');

    const stats = await computeGroupGenderStats(fixture.groupId);
    assert.equal(stats.male, 1);
    assert.equal(stats.female, 0, 'cancelled/removed canonicals must never count');
    assert.equal(stats.total, 1);
  } finally {
    await cleanupGroup(fixture);
  }
});

test('computeGroupGenderStats follows a MOVE_TO_GROUP relocation: counts in the destination group, never the origin, even though telegram_messages.group_id never changes', async () => {
  const origin = await createGroup();
  const destination = await createGroup();
  try {
    // reassignLinkToGroup only ever updates passport_message_links.group_id
    // -- telegram_messages.group_id is fixed at ingest and never touched by
    // a move (see that function's own doc comment) -- so the link's
    // group_id here is deliberately the DESTINATION while the message's own
    // group_id (set via addPassenger) stays the ORIGIN, exactly reproducing
    // real post-move state.
    await addLinkedPassenger(origin, 'male', 'canonical', 'active', destination.groupId);

    const originStats = await computeGroupGenderStats(origin.groupId);
    const destinationStats = await computeGroupGenderStats(destination.groupId);

    assert.deepEqual(originStats, { male: 0, female: 0, unspecified: 0, total: 0 }, 'the origin group must not keep counting a moved-away passenger');
    assert.deepEqual(destinationStats, { male: 1, female: 0, unspecified: 0, total: 1 }, 'the destination group must count it');
  } finally {
    await cleanupGroup(origin);
    await cleanupGroup(destination);
  }
});

test('computeGroupGenderStats: a message with no passport_message_links row at all falls back to telegram_messages.group_id (pre-feature behavior preserved)', async () => {
  const fixture = await createGroup();
  try {
    await addPassenger(fixture, 'male'); // no link row created

    const stats = await computeGroupGenderStats(fixture.groupId);
    assert.deepEqual(stats, { male: 1, female: 0, unspecified: 0, total: 1 });
  } finally {
    await cleanupGroup(fixture);
  }
});

after(async () => {
  await pool.end();
});
