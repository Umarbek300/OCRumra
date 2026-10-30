import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { findGroupByTelegramChatId } from '../src/db/repositories/groups.repo.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import {
  createQueueForBatch,
  createSubmissionAttempt,
  findApplicantGroupId,
  findQueueRecordByApplicantId,
  flagAmbiguousForReview,
} from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { visaContinueApplicantCommand, type VisaContinueApplicantCommandDependencies } from '../src/visa/visaContinueApplicantCommand.js';
import { buildPostgresVisaSubmissionQueueStore } from '../src/visa/visaSubmissionQueuePostgresStore.js';
import type { VisitSaudiSessionAvailability } from '../src/visa/visitSaudiActiveSession.js';

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  await browser.close();
});

/**
 * Every real dependency EXCEPT getActiveSession, which this file's own
 * tests override with a hand-built LOCAL Playwright page fixture (same
 * convention as visa.visaStartSubmissionCommand.test.ts's own tests) --
 * so these tests prove the real Postgres-backed claim/finalize/
 * flagAmbiguousForReview chain genuinely works, without ever opening a
 * real browser session or connecting to the real VisitSaudi portal.
 */
function buildRealDepsWithFakeSession(
  getActiveSession: (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability>,
): VisaContinueApplicantCommandDependencies {
  return {
    findGroup: findGroupByTelegramChatId,
    findApplicantGroupId,
    findQueueRecordByApplicantId,
    flagAmbiguousForReview,
    buildQueueStore: buildPostgresVisaSubmissionQueueStore,
    getActiveSession,
    nowMs: () => Date.now(),
  };
}

function fakeSessionAvailable(targetPage: Page): (anchorTexts: string | readonly string[]) => Promise<VisitSaudiSessionAvailability> {
  return async () => ({ available: true, page: targetPage, release: async () => undefined });
}

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `CONTINUECMDTEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-28';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Continue Applicant Command Test Group', DEPARTURE_DATE, chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

async function createActiveApplicant(groupId: string): Promise<{ applicantId: string; batchId: string }> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const assignment = await assignVisaBatch(groupId, identity.id, 'visitsaudi', DEPARTURE_DATE);
  return { applicantId: assignment.id, batchId: assignment.batchId };
}

/** Mirrors visaQueueBatchCommand's own internal queueing steps directly -- same convention as tests/visa.visaStartSubmissionCommand.test.ts's own queueBatch helper. Returns the created queue row's own id. */
async function queueApplicant(batchId: string, requestedBy: string): Promise<string> {
  const attempt = await createSubmissionAttempt(batchId, requestedBy);
  const created = await createQueueForBatch(batchId, attempt.id);
  assert.ok(created && created.length === 1, 'createQueueForBatch must create exactly one queue row for a single-applicant batch');
  return created[0]!.id;
}

async function cleanupAll(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(
      `DELETE FROM visa_submission_reviews WHERE visa_submission_queue_id IN (SELECT id FROM visa_submission_queue WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(
      `DELETE FROM visa_operator_alerts WHERE visa_submission_queue_id IN (SELECT id FROM visa_submission_queue WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM visa_submission_queue WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)`, [
      groupId,
    ]);
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
    await pool.query(
      `DELETE FROM passport_identity WHERE id IN (SELECT passport_identity_id FROM visa_batch_applicants WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

test('visaContinueApplicantCommand: an unauthorized operator is rejected', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);
    const outcome = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'member', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test("visaContinueApplicantCommand: an operator cannot act on another group's applicant", async () => {
  const groupA = await createGroup();
  const groupB = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupA.groupId);
    const outcome = await visaContinueApplicantCommand({
      telegramChatId: groupB.chatId,
      authorStatus: 'administrator',
      visaBatchApplicantId: applicantId,
    });
    assert.deepEqual(outcome, { kind: 'APPLICANT_NOT_FOUND' });
  } finally {
    await cleanupAll([groupA.groupId, groupB.groupId]);
  }
});

test('visaContinueApplicantCommand: an unknown applicant id is rejected the same way', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaContinueApplicantCommand({
      telegramChatId: chatId,
      authorStatus: 'administrator',
      visaBatchApplicantId: '00000000-0000-0000-0000-000000000000',
    });
    assert.deepEqual(outcome, { kind: 'APPLICANT_NOT_FOUND' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaContinueApplicantCommand: an applicant with no visa_submission_queue row at all (never queued) is rejected as NO_QUEUE_RECORD', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId } = await createActiveApplicant(groupId);

    const outcome = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'administrator', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'NO_QUEUE_RECORD' });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_batch_applicants WHERE id = $1', [applicantId]);
    assert.equal(rows[0]?.status, 'active', 'a rejected call must never change the applicant itself');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaContinueApplicantCommand: a queued but still-PENDING applicant (never reached AWAITING_MANUAL_CONTINUATION) is rejected as NOT_AWAITING_MANUAL_CONTINUATION, never progressed', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const queueId = await queueApplicant(batchId, 'operator:setup');

    const outcome = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'administrator', visaBatchApplicantId: applicantId });
    assert.deepEqual(outcome, { kind: 'NOT_AWAITING_MANUAL_CONTINUATION', currentStatus: 'PENDING' });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueId]);
    assert.equal(rows[0]?.status, 'PENDING', 'a rejected call must never change the queue row\'s own status');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaContinueApplicantCommand: an AWAITING_MANUAL_CONTINUATION applicant with NO active browser session configured (the real default in this test environment -- VISITSAUDI_CDP_ENDPOINT unset) is NEVER faked as CONTINUED', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const queueId = await queueApplicant(batchId, 'operator:setup');
    await pool.query(`UPDATE visa_submission_queue SET status = 'AWAITING_MANUAL_CONTINUATION' WHERE id = $1`, [queueId]);

    // Deliberately uses the REAL default dependencies (no override) --
    // this test environment never sets VISITSAUDI_CDP_ENDPOINT, so this
    // proves the real, unmocked getConfiguredVisitSaudiSession genuinely
    // reports NO_ACTIVE_SESSION rather than this command silently
    // treating that as success.
    const outcome = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'administrator', visaBatchApplicantId: applicantId });
    assert.equal(outcome.kind, 'NO_ACTIVE_SESSION');

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueId]);
    assert.equal(rows[0]?.status, 'AWAITING_MANUAL_CONTINUATION', 'with no session to check anything against, the row must stay exactly as it was');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaContinueApplicantCommand: a genuinely AWAITING_MANUAL_CONTINUATION applicant, with an active (LOCAL fixture) session, reaches CONTINUED -- the queue row ends AMBIGUOUS (never SAVED, never back to PENDING) and a real visa_submission_reviews + visa_operator_alerts row is written via the EXISTING flagAmbiguousForReview mechanism', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const queueId = await queueApplicant(batchId, 'operator:setup');
    await pool.query(`UPDATE visa_submission_queue SET status = 'AWAITING_MANUAL_CONTINUATION' WHERE id = $1`, [queueId]);

    await page.setContent('<p>UPLOAD FILE</p>');
    const deps = buildRealDepsWithFakeSession(fakeSessionAvailable(page));

    const outcome = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId }, deps);
    assert.deepEqual(outcome, { kind: 'CONTINUED', nextApplicantPage3Observed: true });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueId]);
    assert.equal(rows[0]?.status, 'AMBIGUOUS');

    const { rows: reviewRows } = await pool.query<{ detail: string | null }>(
      'SELECT detail FROM visa_submission_reviews WHERE visa_submission_queue_id = $1',
      [queueId],
    );
    assert.equal(reviewRows.length, 1, 'flagAmbiguousForReview must have written exactly one review row');
    assert.match(reviewRows[0]?.detail ?? '', /operator confirmed manual continuation/);

    // Repeating the SAME call again must now be rejected -- the row is no
    // longer AWAITING_MANUAL_CONTINUATION, so a second /visa_continue_applicant
    // press (e.g. a double-tap) can never re-process it.
    const repeat = await visaContinueApplicantCommand({ telegramChatId: chatId, authorStatus: 'creator', visaBatchApplicantId: applicantId }, deps);
    assert.deepEqual(repeat, { kind: 'NOT_AWAITING_MANUAL_CONTINUATION', currentStatus: 'AMBIGUOUS' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaContinueApplicantCommand: TWO CONCURRENT calls for the SAME AWAITING_MANUAL_CONTINUATION applicant, against the REAL Postgres-backed store (both with an active LOCAL fixture session), never both succeed -- the atomic compare-and-swap (never raw SQL) prevents a duplicate submission', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { applicantId, batchId } = await createActiveApplicant(groupId);
    const queueId = await queueApplicant(batchId, 'operator:setup');
    await pool.query(`UPDATE visa_submission_queue SET status = 'AWAITING_MANUAL_CONTINUATION' WHERE id = $1`, [queueId]);

    await page.setContent('<p>UPLOAD FILE</p>');
    const deps = buildRealDepsWithFakeSession(fakeSessionAvailable(page));

    const input = { telegramChatId: chatId, authorStatus: 'administrator' as const, visaBatchApplicantId: applicantId };
    const [outcomeA, outcomeB] = await Promise.all([visaContinueApplicantCommand(input, deps), visaContinueApplicantCommand(input, deps)]);

    const outcomes = [outcomeA, outcomeB];
    assert.equal(outcomes.filter((o) => o.kind === 'CONTINUED').length, 1, 'exactly ONE concurrent call must succeed');
    assert.equal(
      outcomes.filter((o) => o.kind === 'NOT_AWAITING_MANUAL_CONTINUATION').length,
      1,
      'the OTHER concurrent call must be rejected, never silently ignored and never also succeed',
    );

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE id = $1', [queueId]);
    assert.equal(rows[0]?.status, 'AMBIGUOUS', 'the row must end in exactly one final state, never double-processed');

    const { rows: reviewRows } = await pool.query('SELECT id FROM visa_submission_reviews WHERE visa_submission_queue_id = $1', [queueId]);
    assert.equal(reviewRows.length, 1, 'flagAmbiguousForReview must have run exactly once in total, never once per concurrent attempt');
  } finally {
    await cleanupAll([groupId]);
  }
});
