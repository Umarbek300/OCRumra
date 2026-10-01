import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportOcrResult } from '../src/db/repositories/passportOcrResult.repo.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { createPassportMessageLink, findActiveCanonicalLink } from '../src/db/repositories/passportMessageLinks.repo.js';
import {
  createCancelOrRemoveCommand,
  createMoveToGroupCommand,
} from '../src/db/repositories/passportOperatorCommands.repo.js';
import {
  claimReconciliationJob,
  findDueReconciliationJobs,
  findReconciliationJobById,
  findReconciliationJobsForIdentityGroup,
  markReconciliationJobDone,
  markReconciliationJobFailed,
  recoverStaleReconciliationJobs,
  STALE_RECONCILIATION_TIMEOUT_MINUTES,
} from '../src/db/repositories/sheetReconciliation.repo.js';
import { processPassportOperatorCommand, type ProcessOperatorCommandDependencies } from '../src/duplicates/processOperatorCommand.js';
import { mergeIdentities } from '../src/duplicates/mergeIdentities.js';
import { splitLink } from '../src/duplicates/splitLink.js';
import { reconcileSheetRow, type ReconcileSheetRowDependencies } from '../src/sheets/reconcileSheetRow.js';
import { findAgentById } from '../src/db/repositories/agents.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../src/db/repositories/passportOcrResult.repo.js';
import { findTelegramMessageById } from '../src/db/repositories/telegramMessages.repo.js';
import { findActiveCanonicalLink as findActiveCanonicalLinkReal, findActiveDuplicateCandidates } from '../src/db/repositories/passportMessageLinks.repo.js';
import { claimPassportOperatorCommand, markPassportOperatorCommandCompleted, markPassportOperatorCommandFailed } from '../src/db/repositories/passportOperatorCommands.repo.js';
import { retireCanonicalAndPromoteReplacement, promoteReplacementAndRelocateLink } from '../src/duplicates/applyIdentityStateChange.js';
import { findGroupById } from '../src/db/repositories/groups.repo.js';
import { computeGroupGenderStats } from '../src/db/repositories/groupGenderStats.repo.js';

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
  return `RECONCILEINT${Date.now()}${idCounter}`;
}

async function createGroup(): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Reconciliation Integration Test Group', '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

async function createAgent(): Promise<string> {
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(
    `INSERT INTO agents (name, telegram_user_id) VALUES ($1, $2) RETURNING id`,
    ['Reconciliation Integration Test Agent', uniqueUserId()],
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
     ) VALUES ($1,$2,$3,'Reconciliation Integration Test Sender', now(), 'FILE_RECONCILE_INT_TEST', $4, $5)
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
    await pool.query(`UPDATE passport_identity SET merged_into_identity_id = NULL WHERE merged_into_identity_id = $1`, [identityId]);
  }
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM passport_identity WHERE id = $1`, [identityId]);
  }
}

/** Real reconcileSheetRow, real DB repos throughout -- ONLY the Google Sheets boundary (ensureSheet/deleteRow/reassignRow) is faked, with call tracking. */
function fakeReconcileDeps(overrides: Partial<ReconcileSheetRowDependencies> = {}): {
  deps: ReconcileSheetRowDependencies;
  deleteCalls: { spreadsheetId: string; expectedCanonicalTelegramMessageId: string }[];
  reassignCalls: { spreadsheetId: string; oldCanonicalTelegramMessageId: string; newCanonicalTelegramMessageId: string }[];
  ensureSheetCalls: string[];
  writeGenderSummaryCalls: { spreadsheetId: string }[];
} {
  const deleteCalls: { spreadsheetId: string; expectedCanonicalTelegramMessageId: string }[] = [];
  const reassignCalls: { spreadsheetId: string; oldCanonicalTelegramMessageId: string; newCanonicalTelegramMessageId: string }[] = [];
  const ensureSheetCalls: string[] = [];
  const writeGenderSummaryCalls: { spreadsheetId: string }[] = [];

  const deps: ReconcileSheetRowDependencies = {
    claim: claimReconciliationJob,
    markDone: markReconciliationJobDone,
    markFailed: markReconciliationJobFailed,
    findActiveCanonicalLink: findActiveCanonicalLinkReal,
    ensureSheet: async (groupId) => {
      ensureSheetCalls.push(groupId);
      return { spreadsheetId: `sheet-for-${groupId}` };
    },
    deleteRow: async (input) => {
      deleteCalls.push(input);
      return { outcome: 'deleted', rowNumber: 3 };
    },
    reassignRow: async (input) => {
      reassignCalls.push(input);
      return { outcome: 'reassigned', rowNumber: 3 };
    },
    findTelegramMessage: findTelegramMessageById,
    findOcrResult: findPassportOcrResultByTelegramMessageId,
    findAgent: findAgentById,
    findGroup: findGroupById,
    // Real DB-backed stats (matches this file's own "real DB repos
    // throughout" philosophy) -- only the actual Sheets write is faked,
    // same as deleteRow/reassignRow/ensureSheet above.
    computeGenderStats: computeGroupGenderStats,
    writeGenderSummary: async (spreadsheetId) => {
      writeGenderSummaryCalls.push({ spreadsheetId });
    },
    ...overrides,
  };

  return { deps, deleteCalls, reassignCalls, ensureSheetCalls, writeGenderSummaryCalls };
}

/** processPassportOperatorCommand with the Sheets-touching parts faked (destination append for MOVE only -- origin cleanup is entirely reconciliation-driven now). */
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
    ensureSheet: async (groupId) => ({ spreadsheetId: `sheet-for-${groupId}` }),
    findGroup: findGroupById,
    upsertRow: async () => ({ action: 'appended', rowNumber: 2 }),
    retireAndPromote: retireCanonicalAndPromoteReplacement,
    promoteAndRelocate: promoteReplacementAndRelocateLink,
    ...overrides,
  };
}

async function processOneReconciliationJob(jobId: string, overrides: Partial<ReconcileSheetRowDependencies> = {}) {
  const { deps, deleteCalls, reassignCalls, ensureSheetCalls } = fakeReconcileDeps(overrides);
  await reconcileSheetRow(jobId, deps);
  return { deleteCalls, reassignCalls, ensureSheetCalls };
}

// --- CANCEL_PASSPORT ---
test('CANCEL_PASSPORT: reconciliation job stays pending until the worker actually runs, then deletes the row (crash-safe timing decoupling)', async () => {
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
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command.id, fakeCommandDeps());

    // "Crash": the reconciliation job sits pending, untouched, for as long
    // as no worker has run -- this IS the whole point, no timer, no
    // implicit background trigger, entirely decoupled from command processing.
    const jobsBefore = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobsBefore.length, 1);
    assert.equal(jobsBefore[0]?.status, 'pending');

    const { deleteCalls } = await processOneReconciliationJob(jobsBefore[0]!.id);
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0]?.expectedCanonicalTelegramMessageId, messageId);
    assert.equal(deleteCalls[0]?.spreadsheetId, `sheet-for-${groupId}`);

    const jobAfter = await findReconciliationJobById(jobsBefore[0]!.id);
    assert.equal(jobAfter?.status, 'done');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

// --- REMOVE_FROM_GROUP ---
test('REMOVE_FROM_GROUP: reconciliation reassigns to the promoted replacement', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const canonicalMessageId = await createMessage(groupId, agentId);
  const duplicateMessageId = await createMessage(groupId, agentId);
  await createOcrResult(canonicalMessageId);
  await createOcrResult(duplicateMessageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: canonicalMessageId,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: duplicateMessageId,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });

  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'remove_from_group',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: canonicalMessageId,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command.id, fakeCommandDeps());

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1);

    const { reassignCalls } = await processOneReconciliationJob(jobs[0]!.id);
    assert.equal(reassignCalls.length, 1);
    assert.equal(reassignCalls[0]?.oldCanonicalTelegramMessageId, canonicalMessageId);
    assert.equal(reassignCalls[0]?.newCanonicalTelegramMessageId, duplicateMessageId);
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

// --- MOVE_TO_GROUP origin cleanup ---
test('MOVE_TO_GROUP: origin cleanup reconciliation deletes the origin row once the worker runs', async () => {
  const fromGroupId = await createGroup();
  const toGroupId = await createGroup();
  const agentId = await createAgent();
  const messageId = await createMessage(fromGroupId, agentId);
  await createOcrResult(messageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageId,
    groupId: fromGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const command = await createMoveToGroupCommand({
      passportIdentityId: identity.id,
      fromGroupId,
      toGroupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command.id, fakeCommandDeps());

    const originJobs = await findReconciliationJobsForIdentityGroup(identity.id, fromGroupId);
    assert.equal(originJobs.length, 1);
    assert.equal(originJobs[0]?.sourceOperation, 'move_to_group');

    const { deleteCalls, ensureSheetCalls } = await processOneReconciliationJob(originJobs[0]!.id);
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0]?.expectedCanonicalTelegramMessageId, messageId);
    assert.deepEqual(ensureSheetCalls, [fromGroupId], 'reconciliation only ever touches the ORIGIN group -- destination is a separate append, already handled');
  } finally {
    await cleanupAll([fromGroupId, toGroupId], [agentId], [identity.id]);
  }
});

// --- MERGE same-group conflict ---
test('MERGE: same-group conflict reconciliation deletes the demoted side\'s stale row', async () => {
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
  await createPassportMessageLink({
    passportIdentityId: weakIdentity.id,
    telegramMessageId: weakMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: strongIdentity.id,
    telegramMessageId: strongMessage,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const result = await mergeIdentities(weakIdentity.id, strongIdentity.id, 'operator-1');
    assert.equal(result.survivorId, strongIdentity.id);

    const jobs = await findReconciliationJobsForIdentityGroup(strongIdentity.id, groupId);
    assert.equal(jobs.length, 1);

    const { deleteCalls } = await processOneReconciliationJob(jobs[0]!.id);
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0]?.expectedCanonicalTelegramMessageId, weakMessage, 'the demoted weak message\'s row is the one deleted');
  } finally {
    await cleanupAll([groupId], [agentId], [weakIdentity.id, strongIdentity.id]);
  }
});

// --- SPLIT origin cleanup ---
test('SPLIT: origin cleanup reconciliation reassigns to the promoted replacement', async () => {
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
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: duplicateMessage,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  assert.ok(canonicalLink);

  let newIdentityId: string | undefined;
  try {
    const result = await splitLink(canonicalLink.id, 'operator-1');
    assert.equal(result.outcome, 'split');
    if (result.outcome !== 'split') throw new Error('unreachable');
    newIdentityId = result.newIdentityId;

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 1);

    const { reassignCalls } = await processOneReconciliationJob(jobs[0]!.id);
    assert.equal(reassignCalls.length, 1);
    assert.equal(reassignCalls[0]?.oldCanonicalTelegramMessageId, canonicalMessage);
    assert.equal(reassignCalls[0]?.newCanonicalTelegramMessageId, duplicateMessage);
  } finally {
    await cleanupAll([groupId], [agentId], newIdentityId ? [newIdentityId, identity.id] : [identity.id]);
  }
});

// --- Retry after a Sheets-layer failure ---
test('a failed reconciliation attempt is retried and succeeds on a later attempt, without re-running the domain mutation', async () => {
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
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command.id, fakeCommandDeps());

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    const jobId = jobs[0]!.id;

    // First attempt: simulated transient Sheets failure.
    await processOneReconciliationJob(jobId, { deleteRow: async () => { throw new Error('Sheets API unavailable: simulated'); } });
    const afterFailure = await findReconciliationJobById(jobId);
    assert.equal(afterFailure?.status, 'failed');
    assert.equal(afterFailure?.attempts, 1);

    // Force it due immediately (bypass the real backoff delay for the test).
    await pool.query(`UPDATE sheet_reconciliation_jobs SET next_attempt_at = now() WHERE id = $1`, [jobId]);

    // Second attempt: succeeds.
    const { deleteCalls } = await processOneReconciliationJob(jobId);
    assert.equal(deleteCalls.length, 1, 'the retry performs the Sheets action exactly once on this attempt');

    const afterSuccess = await findReconciliationJobById(jobId);
    assert.equal(afterSuccess?.status, 'done');
    assert.equal(afterSuccess?.attempts, 2);

    // The domain mutation (link retirement) happened exactly once, back
    // when the command was first processed -- never re-applied by the retry.
    const events = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM passport_identity_events WHERE passport_identity_id = $1 AND event_type = 'cancel_passport'`,
      [identity.id],
    );
    assert.equal(events.rows[0]?.count, 1);
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

// --- Stale-processing recovery, end to end ---
test('a reconciliation job abandoned mid-processing is recovered and successfully completed', async () => {
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
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageId,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command.id, fakeCommandDeps());

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    const jobId = jobs[0]!.id;

    await claimReconciliationJob(jobId); // -> processing, simulating a worker that then crashed before finishing
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`UPDATE sheet_reconciliation_jobs SET updated_at = now() - ($2 * interval '1 minute') WHERE id = $1`, [
        jobId,
        STALE_RECONCILIATION_TIMEOUT_MINUTES + 1,
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { requeued } = await recoverStaleReconciliationJobs();
    assert.ok(requeued.some((j) => j.id === jobId));

    const due = await findDueReconciliationJobs(50);
    assert.ok(due.some((j) => j.id === jobId));

    const { deleteCalls } = await processOneReconciliationJob(jobId);
    assert.equal(deleteCalls.length, 1);

    const finalJob = await findReconciliationJobById(jobId);
    assert.equal(finalJob?.status, 'done');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

// --- Stacked operations / out-of-order convergence ---
test('two stacked CANCEL_PASSPORT operations on the same group converge correctly regardless of which reconciliation job runs first', async () => {
  const groupId = await createGroup();
  const agentId = await createAgent();
  const messageA = await createMessage(groupId, agentId);
  const messageB = await createMessage(groupId, agentId);
  const messageC = await createMessage(groupId, agentId);
  await createOcrResult(messageA);
  // B strictly stronger than C so op1's promotion is unambiguous (no
  // tie-break needed); C is all that remains for op2 to promote.
  await createOcrResult(messageB, 'high', 'high');
  await createOcrResult(messageC, 'medium', 'high');
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageA,
    groupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageB,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: messageC,
    groupId,
    agentId,
    role: 'duplicate',
    matchConfidenceTier: 'high',
  });

  try {
    // op1: cancel A (currently canonical) -> B gets promoted to canonical.
    const command1 = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageA,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command1.id, fakeCommandDeps());
    const canonicalAfterOp1 = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(canonicalAfterOp1?.telegramMessageId, messageB);

    // op2: cancel B BEFORE op1's own reconciliation job has ever run -> C gets promoted.
    const command2 = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId,
      telegramMessageId: messageB,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command2.id, fakeCommandDeps());
    const canonicalAfterOp2 = await findActiveCanonicalLink(identity.id, groupId);
    assert.equal(canonicalAfterOp2?.telegramMessageId, messageC);

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, groupId);
    assert.equal(jobs.length, 2, 'both operations each enqueued their own job before either was processed');
    const jobAnchoredAtA = jobs.find((j) => j.expectedOldCanonicalTelegramMessageId === messageA)!;
    const jobAnchoredAtB = jobs.find((j) => j.expectedOldCanonicalTelegramMessageId === messageB)!;
    assert.ok(jobAnchoredAtA);
    assert.ok(jobAnchoredAtB);

    // Process job1 (anchored at A) FIRST: the Sheet still shows A's row
    // (nothing has touched it yet), so it must be found and reassigned --
    // and since the CURRENT truth is re-resolved fresh, it goes straight to
    // C (the actual current canonical), skipping the now-superseded B.
    const { reassignCalls: reassignCallsJob1 } = await processOneReconciliationJob(jobAnchoredAtA.id);
    assert.equal(reassignCallsJob1.length, 1);
    assert.equal(reassignCallsJob1[0]?.oldCanonicalTelegramMessageId, messageA);
    assert.equal(reassignCallsJob1[0]?.newCanonicalTelegramMessageId, messageC, 'skips straight to the CURRENT truth, not the now-superseded B');

    // Process job2 (anchored at B) SECOND: B's row never existed
    // independently in the Sheet (job1 already repointed A's row straight
    // to C) -- this must be a safe not_found no-op, not a second write.
    const { deps: deps2, reassignCalls: reassignCallsJob2, deleteCalls: deleteCallsJob2 } = fakeReconcileDeps({
      reassignRow: async () => ({ outcome: 'not_found' }),
    });
    await reconcileSheetRow(jobAnchoredAtB.id, deps2);
    assert.equal(reassignCallsJob2.length, 0, 'the fake itself returns not_found without being asked to reassign anything real');
    assert.equal(deleteCallsJob2.length, 0);

    const jobBAfter = await findReconciliationJobById(jobAnchoredAtB.id);
    assert.equal(jobBAfter?.status, 'done', 'a not_found outcome is still a successful, idempotent no-op');
  } finally {
    await cleanupAll([groupId], [agentId], [identity.id]);
  }
});

// --- Unrelated Sheet rows untouched ---
test('processing a reconciliation job never touches any other group\'s spreadsheet', async () => {
  const targetGroupId = await createGroup();
  const unrelatedGroupId = await createGroup();
  const agentId = await createAgent();
  const targetMessageId = await createMessage(targetGroupId, agentId);
  await createOcrResult(targetMessageId);
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  await createPassportMessageLink({
    passportIdentityId: identity.id,
    telegramMessageId: targetMessageId,
    groupId: targetGroupId,
    agentId,
    role: 'canonical',
    matchConfidenceTier: 'new_identity',
  });

  try {
    const command = await createCancelOrRemoveCommand({
      commandType: 'cancel_passport',
      passportIdentityId: identity.id,
      groupId: targetGroupId,
      telegramMessageId: targetMessageId,
      operatorId: 'operator-1',
    });
    await processPassportOperatorCommand(command.id, fakeCommandDeps());

    const jobs = await findReconciliationJobsForIdentityGroup(identity.id, targetGroupId);
    const { deleteCalls, ensureSheetCalls } = await processOneReconciliationJob(jobs[0]!.id);

    assert.deepEqual(ensureSheetCalls, [targetGroupId]);
    for (const call of deleteCalls) {
      assert.equal(call.spreadsheetId, `sheet-for-${targetGroupId}`);
      assert.notEqual(call.spreadsheetId, `sheet-for-${unrelatedGroupId}`);
    }
  } finally {
    await cleanupAll([targetGroupId, unrelatedGroupId], [agentId], [identity.id]);
  }
});

after(async () => {
  await pool.end();
});
