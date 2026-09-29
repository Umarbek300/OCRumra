import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import {
  findPassportOperatorCommandById,
  markPassportOperatorCommandCompleted,
} from '../src/db/repositories/passportOperatorCommands.repo.js';
import { submitOperatorCommand } from '../src/duplicates/submitOperatorCommand.js';

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
  return `SUBMITCMDTEST${Date.now()}${idCounter}`;
}

async function createGroup(): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Submit Operator Command Test Group', '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(`INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`, [
    'Submit Operator Command Test Agent',
    uniqueUserId(),
  ]);
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
     ) VALUES ($1,$2,$3,'Submit Operator Command Test Sender', now(), 'FILE_SUBMIT_CMD_TEST', $4, $5)
     RETURNING id`,
    [uniqueChatId(), uniqueMessageId(), uniqueUserId(), groupId, agentId],
  );
  assert.ok(message);
  return message.id;
}

async function cleanupAll(groupIds: string[], agentIds: string[], identityIds: string[]): Promise<void> {
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM passport_operator_commands WHERE passport_identity_id = $1`, [identityId]);
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

test('submitOperatorCommand inserts a cancel_passport command and never mutates passport state itself', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(groupId, agentId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);

  try {
    const result = await submitOperatorCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });

    assert.equal(result.outcome, 'inserted');
    assert.equal(result.command.commandType, 'cancel_passport');
    assert.equal(result.command.status, 'pending', 'the entry point never mutates state itself -- the row stays pending for the processor');

    const stored = await findPassportOperatorCommandById(result.command.id);
    assert.equal(stored?.status, 'pending');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('submitOperatorCommand inserts a move_to_group command with both group ids', async () => {
  const fromGroupId = await createGroup();
  const toGroupId = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);

  try {
    const result = await submitOperatorCommand({
      commandType: 'move_to_group',
      passportIdentityId: identity.id,
      fromGroupId,
      toGroupId,
      telegramMessageId: null,
      operatorId: 'operator-1',
    });

    assert.equal(result.outcome, 'inserted');
    assert.equal(result.command.fromGroupId, fromGroupId);
    assert.equal(result.command.toGroupId, toGroupId);
  } finally {
    await cleanupAll([fromGroupId, toGroupId], [], [identity.id]);
  }
});

test('submitOperatorCommand is idempotent -- resubmitting the same pending command reuses the existing row instead of inserting a duplicate', async () => {
  const groupId = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);

  try {
    const first = await submitOperatorCommand({
      commandType: 'remove_from_group',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: null,
      operatorId: 'operator-1',
    });
    assert.equal(first.outcome, 'inserted');

    const second = await submitOperatorCommand({
      commandType: 'remove_from_group',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: null,
      operatorId: 'operator-2',
    });

    assert.equal(second.outcome, 'already_pending');
    assert.equal(second.command.id, first.command.id, 'no second row is inserted for an identical pending command');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM passport_operator_commands WHERE passport_identity_id = $1`,
      [identity.id],
    );
    assert.equal(rows[0]?.count, 1);
  } finally {
    await cleanupAll([groupId], [], [identity.id]);
  }
});

test('submitOperatorCommand allows a new submission once the prior identical command has completed (not idempotent across completed commands)', async () => {
  const groupId = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);

  try {
    const first = await submitOperatorCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: null,
      operatorId: 'operator-1',
    });
    assert.equal(first.outcome, 'inserted');
    await markPassportOperatorCommandCompleted(first.command.id);

    const second = await submitOperatorCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: null,
      operatorId: 'operator-1',
    });

    assert.equal(second.outcome, 'inserted');
    assert.notEqual(second.command.id, first.command.id);
  } finally {
    await cleanupAll([groupId], [], [identity.id]);
  }
});

test('submitOperatorCommand rejects an unknown passport identity id', async () => {
  const groupId = await createGroup();
  try {
    await assert.rejects(() =>
      submitOperatorCommand({
        commandType: 'cancel_passport',
        passportIdentityId: '00000000-0000-0000-0000-000000000000',
        groupId,
        telegramMessageId: null,
        operatorId: 'operator-1',
      }),
    );
  } finally {
    await cleanupAll([groupId], [], []);
  }
});

test('submitOperatorCommand rejects an unknown group id', async () => {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    await assert.rejects(() =>
      submitOperatorCommand({
        commandType: 'cancel_passport',
        passportIdentityId: identity.id,
        groupId: '00000000-0000-0000-0000-000000000000',
        telegramMessageId: null,
        operatorId: 'operator-1',
      }),
    );
  } finally {
    await cleanupAll([], [], [identity.id]);
  }
});

test('submitOperatorCommand rejects move_to_group when fromGroupId equals toGroupId', async () => {
  const groupId = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    await assert.rejects(() =>
      submitOperatorCommand({
        commandType: 'move_to_group',
        passportIdentityId: identity.id,
        fromGroupId: groupId,
        toGroupId: groupId,
        telegramMessageId: null,
        operatorId: 'operator-1',
      }),
    );
  } finally {
    await cleanupAll([groupId], [], [identity.id]);
  }
});

test('submitOperatorCommand rejects a missing operatorId', async () => {
  const groupId = await createGroup();
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  try {
    await assert.rejects(() =>
      submitOperatorCommand({
        commandType: 'cancel_passport',
        passportIdentityId: identity.id,
        groupId,
        telegramMessageId: null,
        operatorId: '',
      }),
    );
  } finally {
    await cleanupAll([groupId], [], [identity.id]);
  }
});
