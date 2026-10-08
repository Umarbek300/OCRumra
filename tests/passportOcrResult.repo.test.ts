import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  createPassportOcrResult,
  findPassportOcrResultByPersonalPhotoToken,
  findPassportOcrResultByTelegramMessageId,
  type CreatePassportOcrResultInput,
} from '../src/db/repositories/passportOcrResult.repo.js';

// This file exercises the repository's actual SQL against a real Postgres
// instance. It's the one place the 29-parameter INSERT in
// createPassportOcrResult is checked for column/parameter-order mistakes —
// every other Stage 4 test mocks this repo out via dependency injection.

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniqueUserId(): number {
  idCounter += 1;
  return Date.now() * 1000 + idCounter;
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
    ['OCR Repo Test Group', '2026-09-20', chatId],
  );
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['OCR Repo Test Agent', senderId],
  );
  assert.ok(group);
  assert.ok(agent);

  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,1,$2,'OCR Repo Test', now(), 'FILE_OCR_REPO_TEST', $3, $4)
     RETURNING id`,
    [chatId, senderId, group.id, agent.id],
  );
  assert.ok(message);

  return { telegramMessageId: message.id, groupId: group.id, agentId: agent.id, chatId };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await pool.query('DELETE FROM telegram_messages WHERE telegram_chat_id = $1', [fixture.chatId]);
  await pool.query('DELETE FROM groups WHERE id = $1', [fixture.groupId]);
  await pool.query('DELETE FROM agents WHERE id = $1', [fixture.agentId]);
}

function field<T extends string = string>(value: T | null, confidence: 'high' | 'medium' | 'low' | null) {
  return { value, confidence };
}

function sampleInput(telegramMessageId: string): CreatePassportOcrResultInput {
  return {
    telegramMessageId,
    firstName: field('Jane', 'high'),
    middleName: field(null, null),
    surname: field('Doe', 'high'),
    passportNumber: field('X1234567', 'high'),
    dateOfBirth: field('1990-05-15', 'high'),
    passportIssueDate: field('2020-01-01', 'high'),
    passportExpiryDate: field('2030-01-01', 'high'),
    gender: field<'male' | 'female' | 'unspecified'>('female', 'high'),
    nationality: field('UZB', 'medium'),
    placeOfBirth: field(null, null),
    issuingAuthority: field(null, null),
    mrz: field('P<UZBDOE<<JANE<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'medium'),
    overallConfidence: 'high',
    rawResponse: { note: 'test payload' },
    provider: 'anthropic',
    model: 'claude-opus-5',
  };
}

test('createPassportOcrResult inserts and round-trips every column correctly', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const created = await createPassportOcrResult(sampleInput(fixture.telegramMessageId));
    assert.ok(created, 'expected the insert to succeed and return a row');

    assert.equal(created.telegramMessageId, fixture.telegramMessageId);
    assert.equal(created.firstName.value, 'Jane');
    assert.equal(created.firstName.confidence, 'high');
    assert.equal(created.middleName.value, null);
    assert.equal(created.middleName.confidence, null);
    assert.equal(created.surname.value, 'Doe');
    assert.equal(created.passportNumber.value, 'X1234567');
    assert.equal(created.dateOfBirth.value, '1990-05-15');
    assert.equal(created.passportIssueDate.value, '2020-01-01');
    assert.equal(created.passportExpiryDate.value, '2030-01-01');
    assert.equal(created.gender.value, 'female');
    assert.equal(created.nationality.value, 'UZB');
    assert.equal(created.nationality.confidence, 'medium');
    assert.equal(created.placeOfBirth.value, null);
    assert.equal(created.issuingAuthority.value, null);
    assert.ok(created.mrz.value?.startsWith('P<UZB'));
    assert.equal(created.overallConfidence, 'high');
    assert.equal(created.provider, 'anthropic');
    assert.equal(created.model, 'claude-opus-5');
    assert.deepEqual(created.rawResponse, { note: 'test payload' });
    assert.ok(created.id);
    assert.ok(created.createdAt);
    assert.ok(created.updatedAt);

    const fetched = await findPassportOcrResultByTelegramMessageId(fixture.telegramMessageId);
    assert.ok(fetched);
    assert.deepEqual(fetched, created);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult returns null on a duplicate telegram_message_id (idempotency at the DB layer)', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const first = await createPassportOcrResult(sampleInput(fixture.telegramMessageId));
    assert.ok(first);

    const second = await createPassportOcrResult(sampleInput(fixture.telegramMessageId));
    assert.equal(second, null);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM passport_ocr_results WHERE telegram_message_id = $1`,
      [fixture.telegramMessageId],
    );
    assert.equal(rows[0]?.count, '1');
  } finally {
    await cleanup(fixture);
  }
});

test('findPassportOcrResultByTelegramMessageId returns null when no result exists yet', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const result = await findPassportOcrResultByTelegramMessageId(fixture.telegramMessageId);
    assert.equal(result, null);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists null values for every field when nothing was extractable', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const allNull = field(null, null);
    const created = await createPassportOcrResult({
      telegramMessageId: fixture.telegramMessageId,
      firstName: allNull,
      middleName: allNull,
      surname: allNull,
      passportNumber: allNull,
      dateOfBirth: allNull,
      passportIssueDate: allNull,
      passportExpiryDate: allNull,
      gender: field<'male' | 'female' | 'unspecified'>(null, null),
      nationality: allNull,
      placeOfBirth: allNull,
      issuingAuthority: allNull,
      mrz: allNull,
      overallConfidence: 'low',
      rawResponse: { note: 'nothing legible' },
      provider: 'anthropic',
      model: 'claude-opus-5',
    });

    assert.ok(created);
    assert.equal(created.firstName.value, null);
    assert.equal(created.passportNumber.value, null);
    assert.equal(created.overallConfidence, 'low');
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists a non-null personal_photo_object_path and it round-trips exactly', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const created = await createPassportOcrResult({
      ...sampleInput(fixture.telegramMessageId),
      personalPhotoObjectPath: `visa-photos/${fixture.telegramMessageId}.jpg`,
    });
    assert.ok(created);
    assert.equal(created.personalPhotoObjectPath, `visa-photos/${fixture.telegramMessageId}.jpg`);

    const fetched = await findPassportOcrResultByTelegramMessageId(fixture.telegramMessageId);
    assert.equal(fetched?.personalPhotoObjectPath, `visa-photos/${fixture.telegramMessageId}.jpg`);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists a null personal_photo_object_path when omitted (photo storage not configured, or upload failed)', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const created = await createPassportOcrResult(sampleInput(fixture.telegramMessageId));
    assert.ok(created);
    assert.equal(created.personalPhotoObjectPath, null);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists personal_photo_token together with personal_photo_object_path and both round-trip exactly', async () => {
  const fixture = await createLinkedTelegramMessage();
  const token = `token-${fixture.telegramMessageId}`;
  try {
    const created = await createPassportOcrResult({
      ...sampleInput(fixture.telegramMessageId),
      personalPhotoObjectPath: `visa-photos/${fixture.telegramMessageId}.jpg`,
      personalPhotoToken: token,
    });
    assert.ok(created);
    assert.equal(created.personalPhotoToken, token);
    assert.equal(created.personalPhotoObjectPath, `visa-photos/${fixture.telegramMessageId}.jpg`);

    const fetchedByMessageId = await findPassportOcrResultByTelegramMessageId(fixture.telegramMessageId);
    assert.equal(fetchedByMessageId?.personalPhotoToken, token);

    const fetchedByToken = await findPassportOcrResultByPersonalPhotoToken(token);
    assert.ok(fetchedByToken);
    assert.equal(fetchedByToken.id, created.id);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists a null personal_photo_token when omitted', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const created = await createPassportOcrResult(sampleInput(fixture.telegramMessageId));
    assert.ok(created);
    assert.equal(created.personalPhotoToken, null);
  } finally {
    await cleanup(fixture);
  }
});

test('findPassportOcrResultByPersonalPhotoToken returns null for a value that matches no row (e.g. a telegram_message_id passed by mistake)', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    await createPassportOcrResult({
      ...sampleInput(fixture.telegramMessageId),
      personalPhotoToken: `token-${fixture.telegramMessageId}`,
    });

    const result = await findPassportOcrResultByPersonalPhotoToken(fixture.telegramMessageId);
    assert.equal(result, null, 'a telegram_message_id must never resolve via the token lookup, even though a row with that message id exists');
  } finally {
    await cleanup(fixture);
  }
});

test('the database enforces uniqueness of personal_photo_token across rows', async () => {
  const fixtureA = await createLinkedTelegramMessage();
  const fixtureB = await createLinkedTelegramMessage();
  const sharedToken = `duplicate-token-${Date.now()}`;
  try {
    const first = await createPassportOcrResult({
      ...sampleInput(fixtureA.telegramMessageId),
      personalPhotoToken: sharedToken,
    });
    assert.ok(first);

    await assert.rejects(
      () =>
        createPassportOcrResult({
          ...sampleInput(fixtureB.telegramMessageId),
          personalPhotoToken: sharedToken,
        }),
      /duplicate key value violates unique constraint/,
    );
  } finally {
    await cleanup(fixtureA);
    await cleanup(fixtureB);
  }
});

// --- personal portrait (cropped) fields — fully independent from personal_photo_*, see migration 0027 ---

test('createPassportOcrResult persists a non-null personal_portrait_object_path and it round-trips exactly, independent of personal_photo_object_path', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const created = await createPassportOcrResult({
      ...sampleInput(fixture.telegramMessageId),
      personalPhotoObjectPath: `visa-photos/${fixture.telegramMessageId}.jpg`,
      personalPortraitObjectPath: `visa-photos/${fixture.telegramMessageId}-portrait.jpg`,
    });
    assert.ok(created);
    assert.equal(created.personalPhotoObjectPath, `visa-photos/${fixture.telegramMessageId}.jpg`);
    assert.equal(created.personalPortraitObjectPath, `visa-photos/${fixture.telegramMessageId}-portrait.jpg`);
    assert.notEqual(created.personalPortraitObjectPath, created.personalPhotoObjectPath);

    const fetched = await findPassportOcrResultByTelegramMessageId(fixture.telegramMessageId);
    assert.equal(fetched?.personalPortraitObjectPath, `visa-photos/${fixture.telegramMessageId}-portrait.jpg`);
    assert.equal(fetched?.personalPhotoObjectPath, `visa-photos/${fixture.telegramMessageId}.jpg`);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists a null personal_portrait_object_path when omitted, even when personal_photo_object_path is set', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const created = await createPassportOcrResult({
      ...sampleInput(fixture.telegramMessageId),
      personalPhotoObjectPath: `visa-photos/${fixture.telegramMessageId}.jpg`,
    });
    assert.ok(created);
    assert.equal(created.personalPortraitObjectPath, null);
    assert.equal(created.personalPhotoObjectPath, `visa-photos/${fixture.telegramMessageId}.jpg`);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists personal_portrait_token together with personal_portrait_object_path, and findPassportOcrResultByPersonalPhotoToken matches it too', async () => {
  const fixture = await createLinkedTelegramMessage();
  const photoToken = `photo-token-${fixture.telegramMessageId}`;
  const portraitToken = `portrait-token-${fixture.telegramMessageId}`;
  try {
    const created = await createPassportOcrResult({
      ...sampleInput(fixture.telegramMessageId),
      personalPhotoObjectPath: `visa-photos/${fixture.telegramMessageId}.jpg`,
      personalPhotoToken: photoToken,
      personalPortraitObjectPath: `visa-photos/${fixture.telegramMessageId}-portrait.jpg`,
      personalPortraitToken: portraitToken,
    });
    assert.ok(created);
    assert.equal(created.personalPortraitToken, portraitToken);
    assert.notEqual(created.personalPortraitToken, created.personalPhotoToken);

    // The SAME lookup function used by the public /visa-photos/:token route
    // must find this row via EITHER token — see applicantPhotoRoute.ts,
    // which then picks the matching object path itself.
    const fetchedByPhotoToken = await findPassportOcrResultByPersonalPhotoToken(photoToken);
    assert.ok(fetchedByPhotoToken);
    assert.equal(fetchedByPhotoToken.id, created.id);

    const fetchedByPortraitToken = await findPassportOcrResultByPersonalPhotoToken(portraitToken);
    assert.ok(fetchedByPortraitToken);
    assert.equal(fetchedByPortraitToken.id, created.id);
  } finally {
    await cleanup(fixture);
  }
});

test('createPassportOcrResult persists a null personal_portrait_token when omitted', async () => {
  const fixture = await createLinkedTelegramMessage();
  try {
    const created = await createPassportOcrResult(sampleInput(fixture.telegramMessageId));
    assert.ok(created);
    assert.equal(created.personalPortraitToken, null);
  } finally {
    await cleanup(fixture);
  }
});

test('the database enforces uniqueness of personal_portrait_token across rows, independent from the personal_photo_token uniqueness constraint', async () => {
  const fixtureA = await createLinkedTelegramMessage();
  const fixtureB = await createLinkedTelegramMessage();
  const sharedPortraitToken = `duplicate-portrait-token-${Date.now()}`;
  try {
    const first = await createPassportOcrResult({
      ...sampleInput(fixtureA.telegramMessageId),
      personalPortraitToken: sharedPortraitToken,
    });
    assert.ok(first);

    await assert.rejects(
      () =>
        createPassportOcrResult({
          ...sampleInput(fixtureB.telegramMessageId),
          personalPortraitToken: sharedPortraitToken,
        }),
      /duplicate key value violates unique constraint/,
    );
  } finally {
    await cleanup(fixtureA);
    await cleanup(fixtureB);
  }
});

test('a personal_photo_token and a personal_portrait_token may safely share the same string value on DIFFERENT rows (independent unique indexes, no cross-column constraint)', async () => {
  const fixtureA = await createLinkedTelegramMessage();
  const fixtureB = await createLinkedTelegramMessage();
  const sharedValue = `cross-column-value-${Date.now()}`;
  try {
    const first = await createPassportOcrResult({
      ...sampleInput(fixtureA.telegramMessageId),
      personalPhotoToken: sharedValue,
    });
    assert.ok(first);

    const second = await createPassportOcrResult({
      ...sampleInput(fixtureB.telegramMessageId),
      personalPortraitToken: sharedValue,
    });
    assert.ok(second, 'the two unique indexes are on different columns, so this must succeed');
  } finally {
    await cleanup(fixtureA);
    await cleanup(fixtureB);
  }
});

after(async () => {
  await pool.end();
});
