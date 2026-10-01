import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { removePassportCommand } from '../src/bot/removePassportCommand.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { createPassportMessageLink, findActiveCanonicalLink } from '../src/db/repositories/passportMessageLinks.repo.js';
import { createCancelOrRemoveCommand } from '../src/db/repositories/passportOperatorCommands.repo.js';
import { processPassportOperatorCommand, type ProcessOperatorCommandDependencies } from '../src/duplicates/processOperatorCommand.js';
import { findActiveCanonicalLink as findActiveCanonicalLinkReal, findActiveDuplicateCandidates } from '../src/db/repositories/passportMessageLinks.repo.js';
import { claimPassportOperatorCommand, markPassportOperatorCommandCompleted, markPassportOperatorCommandFailed } from '../src/db/repositories/passportOperatorCommands.repo.js';
import { retireCanonicalAndPromoteReplacement, promoteReplacementAndRelocateLink } from '../src/duplicates/applyIdentityStateChange.js';
import { findAgentById } from '../src/db/repositories/agents.repo.js';
import { findPassportOcrResultByTelegramMessageId, createPassportOcrResult } from '../src/db/repositories/passportOcrResult.repo.js';
import { findTelegramMessageById } from '../src/db/repositories/telegramMessages.repo.js';
import { findGroupById } from '../src/db/repositories/groups.repo.js';
import { ensureGroupSheet } from '../src/sheets/ensureGroupSheet.js';
import { upsertRowInSheet } from '../src/sheets/upsertRowInSheet.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniqueUserId(): number {
  idCounter += 1;
  return Date.now() * 1000 + idCounter;
}
function uniqueTgMessageId(): number {
  idCounter += 1;
  return idCounter;
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `REMOVECMDTEST${Date.now()}${idCounter}`;
}

async function createGroup(): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Remove Command Test Group', '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Remove Command Test Agent', uniqueUserId()],
  );
  assert.ok(agent);
  return agent.id;
}

async function createMessage(
  groupId: string,
  agentId: string | null,
  chatId: number,
): Promise<{ id: string; tgMessageId: number }> {
  const tgMessageId = uniqueTgMessageId();
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id
     ) VALUES ($1,$2,$3,'Remove Command Test Sender', now(), 'FILE_REMOVE_CMD_TEST', $4, $5)
     RETURNING id`,
    [chatId, tgMessageId, uniqueUserId(), groupId, agentId],
  );
  assert.ok(message);
  return { id: message.id, tgMessageId };
}

async function createOcrResult(telegramMessageId: string): Promise<void> {
  await createPassportOcrResult({
    telegramMessageId,
    firstName: { value: 'JOHN', confidence: 'high' },
    middleName: { value: null, confidence: null },
    surname: { value: 'DOE', confidence: 'high' },
    passportNumber: { value: 'AB1234567', confidence: 'high' },
    dateOfBirth: { value: '1990-01-01', confidence: 'high' },
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

function fakeCommandDeps(overrides: Partial<ProcessOperatorCommandDependencies> = {}): ProcessOperatorCommandDependencies {
  return {
    claim: claimPassportOperatorCommand,
    markCompleted: markPassportOperatorCommandCompleted,
    markFailed: markPassportOperatorCommandFailed,
    findActiveCanonicalLink: findActiveCanonicalLinkReal,
    findActiveDuplicateCandidates,
    findTelegramMessage: findTelegramMessageById,
    findOcrResult: findPassportOcrResultByTelegramMessageId,
    findAgent: findAgentById,
    ensureSheet: ensureGroupSheet,
    findGroup: findGroupById,
    upsertRow: upsertRowInSheet,
    retireAndPromote: retireCanonicalAndPromoteReplacement,
    promoteAndRelocate: promoteReplacementAndRelocateLink,
    ...overrides,
  };
}

async function cleanupAll(groupIds: string[], agentIds: string[], identityIds: string[]): Promise<void> {
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM sheet_reconciliation_jobs WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_operator_commands WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_message_links WHERE passport_identity_id = $1`, [identityId]);
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

test('removePassportCommand: MESSAGE_NOT_FOUND when no telegram_messages row matches (chatId, tgMessageId)', async () => {
  const outcome = await removePassportCommand({
    telegramChatId: uniqueChatId(),
    telegramMessageId: uniqueTgMessageId(),
    operatorId: 'telegram:tester',
  });
  assert.deepEqual(outcome, { kind: 'MESSAGE_NOT_FOUND' });
});

test('removePassportCommand: NOT_A_PASSPORT_MESSAGE when the message exists but has no passport_message_links row', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const chatId = uniqueChatId();
  const message = await createMessage(groupId, agentId, chatId);

  try {
    const outcome = await removePassportCommand({
      telegramChatId: chatId,
      telegramMessageId: message.tgMessageId,
      operatorId: 'telegram:tester',
    });
    assert.deepEqual(outcome, { kind: 'NOT_A_PASSPORT_MESSAGE' });
  } finally {
    await cleanupAll([groupId], [agentId], []);
  }
});

test('removePassportCommand: submits a remove_from_group command for a normal canonical passport message', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const chatId = uniqueChatId();
  const message = await createMessage(groupId, agentId, chatId);
  await createOcrResult(message.id);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: message.id,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const outcome = await removePassportCommand({
      telegramChatId: chatId,
      telegramMessageId: message.tgMessageId,
      operatorId: 'telegram:tester',
    });
    assert.deepEqual(outcome, { kind: 'SUBMITTED', alreadyPending: false });

    const { rows } = await pool.query<{ command_type: string; status: string; group_id: string }>(
      `SELECT command_type, status, group_id FROM passport_operator_commands WHERE passport_identity_id = $1`,
      [identity.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.command_type, 'remove_from_group');
    assert.equal(rows[0]?.status, 'pending');
    assert.equal(rows[0]?.group_id, groupId);
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('removePassportCommand: replying twice before the worker runs returns alreadyPending=true, never a duplicate command', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const chatId = uniqueChatId();
  const message = await createMessage(groupId, agentId, chatId);
  await createOcrResult(message.id);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: message.id,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const first = await removePassportCommand({
      telegramChatId: chatId,
      telegramMessageId: message.tgMessageId,
      operatorId: 'telegram:tester',
    });
    assert.deepEqual(first, { kind: 'SUBMITTED', alreadyPending: false });

    const second = await removePassportCommand({
      telegramChatId: chatId,
      telegramMessageId: message.tgMessageId,
      operatorId: 'telegram:tester',
    });
    assert.deepEqual(second, { kind: 'SUBMITTED', alreadyPending: true });

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM passport_operator_commands WHERE passport_identity_id = $1`,
      [identity.id],
    );
    assert.equal(rows[0]?.count, '1', 'a repeated /remove reply before the worker runs must never insert a second command');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('removePassportCommand: ALREADY_REMOVED once the (identity, group) has no active canonical left', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const chatId = uniqueChatId();
  const message = await createMessage(groupId, agentId, chatId);
  await createOcrResult(message.id);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: message.id,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'remove_from_group',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: message.id,
      operatorId: 'telegram:tester',
    });
    await processPassportOperatorCommand(command.id, fakeCommandDeps());

    const canonicalAfter = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(canonicalAfter, null, 'sanity check: the passport has genuinely been retired already');

    const outcome = await removePassportCommand({
      telegramChatId: chatId,
      telegramMessageId: message.tgMessageId,
      operatorId: 'telegram:tester',
    });
    assert.deepEqual(outcome, { kind: 'ALREADY_REMOVED' });

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM passport_operator_commands WHERE passport_identity_id = $1`,
      [identity.id],
    );
    assert.equal(rows[0]?.count, '1', 'ALREADY_REMOVED must never submit a second command');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('removePassportCommand: replying to a non-canonical (duplicate-role) message still targets the group\'s current canonical', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const chatId = uniqueChatId();
  const canonicalMessage = await createMessage(groupId, agentId, chatId);
  const duplicateMessage = await createMessage(groupId, agentId, chatId);
  await createOcrResult(canonicalMessage.id);
  await createOcrResult(duplicateMessage.id);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: canonicalMessage.id,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: duplicateMessage.id,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });

  try {
    // Operator replies /remove to the DUPLICATE message, not the canonical one.
    const outcome = await removePassportCommand({
      telegramChatId: chatId,
      telegramMessageId: duplicateMessage.tgMessageId,
      operatorId: 'telegram:tester',
    });
    assert.deepEqual(outcome, { kind: 'SUBMITTED', alreadyPending: false });

    const { rows } = await pool.query<{ group_id: string; passport_identity_id: string }>(
      `SELECT group_id, passport_identity_id FROM passport_operator_commands WHERE passport_identity_id = $1`,
      [identity.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.group_id, groupId, 'targets the (identity, group) pair, not just the specific replied-to message');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('findTelegramMessageByChatAndMessageId (used internally by removePassportCommand) distinguishes by BOTH chatId and tgMessageId', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const chatA = uniqueChatId();
  const chatB = uniqueChatId();
  const messageInA = await createMessage(groupId, agentId, chatA);

  try {
    // Same numeric message id would never happen in practice for two
    // different chats to collide by our own uniqueTgMessageId generator, so
    // assert on the actually-relevant property instead: chat B genuinely
    // has no message with A's tgMessageId.
    const outcome = await removePassportCommand({
      telegramChatId: chatB,
      telegramMessageId: messageInA.tgMessageId,
      operatorId: 'telegram:tester',
    });
    assert.deepEqual(outcome, { kind: 'MESSAGE_NOT_FOUND' }, 'a message from a DIFFERENT chat must never match');
  } finally {
    await cleanupAll([groupId], [agentId], []);
  }
});
