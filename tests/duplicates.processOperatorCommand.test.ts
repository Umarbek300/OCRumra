import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportOcrResult } from '../src/db/repositories/passportOcrResult.repo.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { findGroupById, type Group } from '../src/db/repositories/groups.repo.js';
import {
  createPassportMessageLink,
  findActiveCanonicalLink,
  findPassportMessageLinkById,
} from '../src/db/repositories/passportMessageLinks.repo.js';
import {
  claimPassportOperatorCommand,
  createCancelOrRemoveCommand,
  createMoveToGroupCommand,
  findPassportOperatorCommandById,
  markPassportOperatorCommandCompleted,
  markPassportOperatorCommandFailed,
} from '../src/db/repositories/passportOperatorCommands.repo.js';
import { listEventsForIdentity } from '../src/db/repositories/passportIdentityEvents.repo.js';
import { processPassportOperatorCommand, type ProcessOperatorCommandDependencies } from '../src/duplicates/processOperatorCommand.js';
import { findActiveCanonicalLink as findActiveCanonicalLinkReal, findActiveDuplicateCandidates } from '../src/db/repositories/passportMessageLinks.repo.js';
import { retireCanonicalAndPromoteReplacement, promoteReplacementAndRelocateLink } from '../src/duplicates/applyIdentityStateChange.js';
import { findAgentById } from '../src/db/repositories/agents.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../src/db/repositories/passportOcrResult.repo.js';
import { findTelegramMessageById } from '../src/db/repositories/telegramMessages.repo.js';
import { findReconciliationJobsForIdentityGroup } from '../src/db/repositories/sheetReconciliation.repo.js';

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
  return `OPCMDTEST${Date.now()}${idCounter}`;
}

async function createGroup(): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Operator Command Test Group', '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Operator Command Test Agent', uniqueUserId()],
  );
  assert.ok(agent);
  return agent.id;
}

async function createMessage(groupId: string, agentId: string | null, captionText: string | null = null): Promise<string> {
  const {
    rows: [message],
  } = await pool.query<{ id: string }>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id, telegram_sender_display_name,
       message_timestamp, telegram_photo_file_id, group_id, agent_id, caption_text
     ) VALUES ($1,$2,$3,'Operator Command Test Sender', now(), 'FILE_OPCMD_TEST', $4, $5, $6)
     RETURNING id`,
    [uniqueChatId(), uniqueMessageId(), uniqueUserId(), groupId, agentId, captionText],
  );
  assert.ok(message);
  return message.id;
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

async function cleanupAll(groupIds: string[], agentIds: string[], identityIds: string[]): Promise<void> {
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM sheet_reconciliation_jobs WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_message_links WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM duplicate_reviews WHERE passport_identity_id = $1`, [identityId]);
    await pool.query(`DELETE FROM passport_identity_events WHERE passport_identity_id = $1`, [identityId]);
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

function fakeDeps(overrides: Partial<ProcessOperatorCommandDependencies> = {}): {
  deps: ProcessOperatorCommandDependencies;
  calls: { upsertRow: number };
  upsertArgs: unknown[];
} {
  const calls = { upsertRow: 0 };
  const upsertArgs: unknown[] = [];

  const deps: ProcessOperatorCommandDependencies = {
    claim: claimPassportOperatorCommand,
    markCompleted: markPassportOperatorCommandCompleted,
    markFailed: markPassportOperatorCommandFailed,
    findActiveCanonicalLink: findActiveCanonicalLinkReal,
    findActiveDuplicateCandidates,
    findTelegramMessage: findTelegramMessageById,
    findOcrResult: findPassportOcrResultByTelegramMessageId,
    findAgent: findAgentById,
    ensureSheet: async (groupId: string) => ({ spreadsheetId: `sheet-for-${groupId}` }),
    findGroup: findGroupById,
    upsertRow: async (input) => {
      calls.upsertRow += 1;
      upsertArgs.push(input);
      return { action: 'appended', rowNumber: 2 };
    },
    retireAndPromote: retireCanonicalAndPromoteReplacement,
    promoteAndRelocate: promoteReplacementAndRelocateLink,
    ...overrides,
  };

  return { deps, calls, upsertArgs };
}

test('cancel_passport with no remaining source deletes the Sheet row and completes the command', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(groupId, agentId);
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });

    const { deps } = fakeDeps();
    await processPassportOperatorCommand(command.id, deps);

    const updatedLink = await findPassportMessageLinkById(link.id);
    assert.equal(updatedLink?.linkStatus, 'cancelled');

    const finalCommand = await findPassportOperatorCommandById(command.id);
    assert.equal(finalCommand?.status, 'completed');

    const events = await listEventsForIdentity(identity.id);
    assert.ok(events.some((e) => e.eventType === 'cancel_passport'));

    // P1: no direct Sheets call happens here any more -- a durable
    // reconciliation job is enqueued in the SAME transaction instead.
    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.expectedOldCanonicalTelegramMessageId, messageId);
    assert.equal(jobs[0]?.sourceOperation, 'cancel_passport');
    assert.equal(jobs[0]?.status, 'pending');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('cancel_passport with a remaining duplicate reassigns canonical instead of deleting the row', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const canonicalMessageId = await createMessage(groupId, agentId);
  const duplicateMessageId = await createMessage(groupId, agentId);
  await createOcrResult(canonicalMessageId);
  await createOcrResult(duplicateMessageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const canonicalLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: canonicalMessageId,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  const duplicateLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: duplicateMessageId,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  assert.ok(canonicalLink);
  assert.ok(duplicateLink);

  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: canonicalMessageId,
      operatorId: 'operator-1',
    });

    const { deps } = fakeDeps();
    await processPassportOperatorCommand(command.id, deps);

    const newCanonical = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(newCanonical?.id, duplicateLink.id);

    const oldLink = await findPassportMessageLinkById(canonicalLink.id);
    assert.equal(oldLink?.linkStatus, 'cancelled');

    // P1: the reconciliation job is anchored at the OLD canonical's message
    // id regardless of whether a replacement exists -- the worker
    // re-resolves the reassign-vs-delete decision fresh, not this caller.
    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.expectedOldCanonicalTelegramMessageId, canonicalMessageId);
    assert.equal(jobs[0]?.sourceOperation, 'cancel_passport');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('cancel_passport is idempotent -- a second command against an already-cancelled identity makes no Sheets calls', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(groupId, agentId);
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const command1 = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    const { deps: deps1 } = fakeDeps();
    await processPassportOperatorCommand(command1.id, deps1);

    const command2 = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    const { deps: deps2 } = fakeDeps();
    await processPassportOperatorCommand(command2.id, deps2);

    const finalCommand2 = await findPassportOperatorCommandById(command2.id);
    assert.equal(finalCommand2?.status, 'completed');

    // P1: no active canonical remains -- retireInGroup's own early-return
    // means the SECOND call never reaches retireAndPromote at all, so no
    // second reconciliation job is enqueued either.
    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1, 'the idempotent no-op second command enqueues no second reconciliation job');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('remove_from_group sets link_status=removed, distinct from cancel_passport\'s cancelled', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(groupId, agentId);
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'remove_from_group',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    const { deps } = fakeDeps();
    await processPassportOperatorCommand(command.id, deps);

    const updatedLink = await findPassportMessageLinkById(link.id);
    assert.equal(updatedLink?.linkStatus, 'removed');

    const events = await listEventsForIdentity(identity.id);
    assert.ok(events.some((e) => e.eventType === 'remove_from_group'));
    assert.ok(!events.some((e) => e.eventType === 'cancel_passport'));

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.sourceOperation, 'remove_from_group');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('move_to_group with no remaining source in the old group deletes the old row and appends a new row in the destination', async () => {
  const fromGroupId = await createGroup();
  const toGroupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(fromGroupId, agentId, 'Package: $1000');
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId: fromGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  try {
    const command = await createMoveToGroupCommand({
      passportIdentityId: identity.id,
      fromGroupId,
      toGroupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    const { deps, calls, upsertArgs } = fakeDeps();
    await processPassportOperatorCommand(command.id, deps);

    assert.equal(calls.upsertRow, 1);
    assert.equal((upsertArgs[0] as { telegramMessageId: string; spreadsheetId: string }).telegramMessageId, messageId);
    assert.equal((upsertArgs[0] as { spreadsheetId: string }).spreadsheetId, `sheet-for-${toGroupId}`);
    assert.equal(
      (upsertArgs[0] as { googleSheetGid: number | null | undefined }).googleSheetGid,
      null,
      'H-1: a legacy destination group (google_sheet_gid null in the DB) passes googleSheetGid as null, unchanged behavior',
    );

    // P1: the ORIGIN group's cleanup is now a durable reconciliation job,
    // not a direct deleteRow call.
    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, fromGroupId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.expectedOldCanonicalTelegramMessageId, messageId);
    assert.equal(jobs[0]?.sourceOperation, 'move_to_group');

    const movedLink = await findPassportMessageLinkById(link.id);
    assert.equal(movedLink?.groupId, toGroupId, 'the SAME link row is repointed, never a second row created');
    assert.equal(movedLink?.role, 'canonical', 'role is never disturbed by a move');
    assert.equal(movedLink?.linkStatus, 'active', 'a moved link must stay active -- marking it otherwise would hide it from the destination group');

    const canonicalInDestination = await findActiveCanonicalLink(identity.id, toGroupId);
    assert.equal(canonicalInDestination?.id, link.id);

    const canonicalInSource = await findActiveCanonicalLink(identity.id, fromGroupId);
    assert.equal(canonicalInSource, null, 'no active canonical remains in the source group');

    const events = await listEventsForIdentity(identity.id);
    assert.ok(events.some((e) => e.eventType === 'group_transferred'));
  } finally {
    await cleanupAll([fromGroupId, toGroupId], [agentId], [identity.id]);
  }
});

test('H-1: move_to_group threads the destination (master/tab) group\'s googleSheetGid into upsertRow, never dropping it', async () => {
  const fromGroupId = await createGroup();
  const toGroupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(fromGroupId, agentId, 'Package: $1000');
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId: fromGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  try {
    const command = await createMoveToGroupCommand({
      passportIdentityId: identity.id,
      fromGroupId,
      toGroupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    // The destination group is a master/tab group in this scenario --
    // overriding findGroup (rather than writing google_sheet_gid into the
    // real DB row) keeps this test a pure dependency-injection unit test,
    // same style as every other fakeDeps override in this file.
    const fakeDestinationGroup: Group = {
      id: toGroupId,
      name: 'Destination Master/Tab Group',
      departureDate: '2026-09-20',
      telegramChatId: null,
      googleSheetId: 'master-abc',
      googleSheetGid: 456789,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { deps, calls, upsertArgs } = fakeDeps({
      findGroup: async (id: string) => (id === toGroupId ? fakeDestinationGroup : findGroupById(id)),
    });
    await processPassportOperatorCommand(command.id, deps);

    assert.equal(calls.upsertRow, 1);
    assert.equal(
      (upsertArgs[0] as { googleSheetGid: number | null | undefined }).googleSheetGid,
      456789,
      'H-1: a master/tab destination group\'s googleSheetGid must reach upsertRow -- never dropped/omitted',
    );
  } finally {
    await cleanupAll([fromGroupId, toGroupId], [agentId], [identity.id]);
  }
});

test('move_to_group with a remaining duplicate in the old group reassigns it there instead of deleting the row', async () => {
  const fromGroupId = await createGroup();
  const toGroupId = await createGroup();
  const agentId = await createAgent();
  const movedMessageId = await createMessage(fromGroupId, agentId);
  const remainingMessageId = await createMessage(fromGroupId, agentId);
  await createOcrResult(movedMessageId);
  await createOcrResult(remainingMessageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const movedLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: movedMessageId,
    groupId: fromGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  const remainingLink = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: remainingMessageId,
    groupId: fromGroupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  assert.ok(movedLink);
  assert.ok(remainingLink);

  try {
    const command = await createMoveToGroupCommand({
      passportIdentityId: identity.id,
      fromGroupId,
      toGroupId,
      telegramMessageId: movedMessageId,
      operatorId: 'operator-1',
    });
    const { deps, calls, upsertArgs } = fakeDeps();
    await processPassportOperatorCommand(command.id, deps);

    assert.equal(calls.upsertRow, 1);
    assert.equal((upsertArgs[0] as { telegramMessageId: string }).telegramMessageId, movedMessageId);

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, fromGroupId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.expectedOldCanonicalTelegramMessageId, movedMessageId);
    assert.equal(jobs[0]?.sourceOperation, 'move_to_group');

    const canonicalInSource = await findActiveCanonicalLink(identity.id, fromGroupId);
    assert.equal(canonicalInSource?.id, remainingLink.id, 'the remaining duplicate becomes fromGroup\'s new canonical');

    const canonicalInDestination = await findActiveCanonicalLink(identity.id, toGroupId);
    assert.equal(canonicalInDestination?.id, movedLink.id);
  } finally {
    await cleanupAll([fromGroupId, toGroupId], [agentId], [identity.id]);
  }
});

test('cancel_passport commits its DB state change and enqueues the reconciliation job even though this function never calls the Sheets API at all any more', async () => {
  // P1: retireInGroup makes NO direct Sheets call whatsoever -- there is
  // nothing left in this path that could throw a "Sheets API unavailable"
  // error the way earlier phases' inline deleteRow call could. This test
  // now documents that fact directly, and the crash/failure-recovery
  // story for the ACTUAL Sheets write lives in
  // tests/sheets.reconcileSheetRow.test.ts and
  // tests/duplicates.sheetReconciliationIntegration.test.ts instead.
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(groupId, agentId);
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    const { deps } = fakeDeps();

    await processPassportOperatorCommand(command.id, deps);

    const finalCommand = await findPassportOperatorCommandById(command.id);
    assert.equal(finalCommand?.status, 'completed');

    const linkAfter = await findPassportMessageLinkById(link.id);
    assert.equal(linkAfter?.linkStatus, 'cancelled');

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1, 'the domain change and the durable IOU for the Sheet fixup are the same atomic commit');
    assert.equal(jobs[0]?.status, 'pending', 'still owed -- no worker has processed it in this test');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

test('move_to_group: a destination-append Sheets failure marks the command failed, but the already-committed domain change and origin reconciliation job are NOT rolled back', async () => {
  const fromGroupId = await createGroup();
  const toGroupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(fromGroupId, agentId);
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const link = await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId: fromGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  assert.ok(link);

  try {
    const command = await createMoveToGroupCommand({
      passportIdentityId: identity.id,
      fromGroupId,
      toGroupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    const { deps } = fakeDeps({
      upsertRow: async () => {
        throw new Error('Sheets API unavailable: simulated failure');
      },
    });

    await processPassportOperatorCommand(command.id, deps);

    const finalCommand = await findPassportOperatorCommandById(command.id);
    assert.equal(finalCommand?.status, 'failed');
    assert.match(finalCommand?.lastError ?? '', /Sheets API unavailable/);

    const movedLink = await findPassportMessageLinkById(link.id);
    assert.equal(
      movedLink?.groupId,
      toGroupId,
      'the domain state change (relocating the link) commits BEFORE the destination Sheets call and is never rolled back by its later failure',
    );

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, fromGroupId);
    assert.equal(jobs.length, 1, 'the origin cleanup job was already durably committed too, independent of the destination append failing');
  } finally {
    await cleanupAll([fromGroupId, toGroupId], [agentId], [identity.id]);
  }
});
