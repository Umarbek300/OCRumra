import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import type { PassportMessageLinkRecord } from '../src/db/repositories/passportMessageLinks.repo.js';
import type { Group } from '../src/db/repositories/groups.repo.js';
import { findVisaBatchById } from '../src/db/repositories/visaBatches.repo.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { validateVerifiedApplicantData } from '../src/visa/validateVerifiedApplicantData.js';
import { visaAssignCommand, type VisaAssignCommandDependencies } from '../src/visa/visaAssignCommand.js';
import type { VerifiedApplicantData } from '../src/visa/types.js';

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `VISAASSIGNCMDTEST${Date.now()}${idCounter}`;
}
function uniqueMessageUuid(index: number): string {
  // A syntactically valid UUID is not required here -- readVerifiedApplicantData
  // and the Sheet are always faked in these tests, so telegramMessageId is
  // never actually used to look anything up; it only needs to be a stable,
  // distinct string per result entry.
  return `fake-message-${Date.now()}-${idCounter}-${index}`;
}

async function createGroup(departureDate = '2026-10-05'): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Visa Assign Command Test Group', departureDate, chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

async function createIdentity(): Promise<string> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  return identity.id;
}

async function cleanupAll(groupIds: string[], identityIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
  }
  for (const identityId of identityIds) {
    await pool.query(`DELETE FROM passport_identity WHERE id = $1`, [identityId]);
  }
  for (const groupId of groupIds) {
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

function fakeLink(groupId: string, passportIdentityId: string, index: number): PassportMessageLinkRecord {
  return {
    id: `fake-link-${index}`,
    passportIdentityId,
    telegramMessageId: uniqueMessageUuid(index),
    groupId,
    agentId: null,
    role: 'canonical',
    linkStatus: 'active',
    matchConfidenceTier: 'new_identity',
    resolvedBy: 'auto',
    createdAt: new Date().toISOString(),
  };
}

function completeData(overrides: Partial<VerifiedApplicantData> = {}): VerifiedApplicantData {
  return {
    firstName: 'JOHN',
    surname: 'DOE',
    passportNumber: 'AB1234567',
    dateOfBirth: '1990-01-01',
    passportIssueDate: '2020-01-01',
    passportExpiryDate: '2030-01-01',
    gender: 'Erkak',
    nationality: 'UZB',
    email: 'john@example.com',
    arrivalDate: '2026-10-05',
    personalPhotoUrl: 'https://example.com/photo.jpg',
    passportScanUrl: '',
    ...overrides,
  };
}

function fakeGroup(groupId: string, departureDate: string): Group {
  return {
    id: groupId,
    name: 'Visa Assign Command Test Group',
    departureDate,
    telegramChatId: null,
    googleSheetId: null,
    googleSheetGid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

interface FakeDepsOptions {
  groupId: string;
  departureDate?: string;
  links?: PassportMessageLinkRecord[];
  groupFound?: boolean;
  readData?: (groupId: string, passportIdentityId: string) => Promise<VerifiedApplicantData | null>;
  useRealAssign?: boolean;
}

function buildFakeDeps(options: FakeDepsOptions): {
  deps: VisaAssignCommandDependencies;
  calls: { findGroup: number; findLinks: number; readData: number; validate: number; assign: number; findBatch: number };
} {
  const calls = { findGroup: 0, findLinks: 0, readData: 0, validate: 0, assign: 0, findBatch: 0 };

  const deps: VisaAssignCommandDependencies = {
    findGroup: async () => {
      calls.findGroup += 1;
      return options.groupFound === false ? null : fakeGroup(options.groupId, options.departureDate ?? '2026-10-05');
    },
    findActiveCanonicalLinksForGroup: async () => {
      calls.findLinks += 1;
      return options.links ?? [];
    },
    readVerifiedApplicantData: async (groupId, passportIdentityId) => {
      calls.readData += 1;
      if (options.readData) {
        return options.readData(groupId, passportIdentityId);
      }
      return completeData();
    },
    validate: (data, portal) => {
      calls.validate += 1;
      return validateVerifiedApplicantData(data, portal);
    },
    assign: async (groupId, passportIdentityId, portal, departureDateIso) => {
      calls.assign += 1;
      if (options.useRealAssign) {
        return assignVisaBatch(groupId, passportIdentityId, portal, departureDateIso);
      }
      return {
        id: `fake-assignment-${passportIdentityId}`,
        batchId: 'fake-batch-1',
        groupId,
        passportIdentityId,
        portal,
        positionInBatch: 1,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    findBatchById: async (id) => {
      calls.findBatch += 1;
      if (options.useRealAssign) {
        return findVisaBatchById(id);
      }
      return {
        id,
        groupId: options.groupId,
        portal: 'visitsaudi',
        batchNumber: 1,
        batchName: '5.10-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
  };

  return { deps, calls };
}

test('UNAUTHORIZED: a non-admin/creator author is rejected before touching any dependency', async () => {
  const { deps, calls } = buildFakeDeps({ groupId: 'irrelevant' });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'member' }, deps);
  assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });
  assert.equal(calls.findGroup, 0, 'no dependency is called once the authorization gate rejects the caller');
});

test('authorStatus creator is accepted (not just administrator)', async () => {
  const { deps } = buildFakeDeps({ groupId: 'g1', links: [] });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'creator' }, deps);
  assert.equal(outcome.kind, 'EMPTY_GROUP');
});

test('GROUP_NOT_FOUND: an unregistered telegram chat id', async () => {
  const { deps } = buildFakeDeps({ groupId: 'irrelevant', groupFound: false });
  const outcome = await visaAssignCommand({ telegramChatId: 999, authorStatus: 'administrator' }, deps);
  assert.deepEqual(outcome, { kind: 'GROUP_NOT_FOUND' });
});

test('EMPTY_GROUP: a registered group with zero active canonical applicants', async () => {
  const { deps } = buildFakeDeps({ groupId: 'g1', links: [] });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);
  assert.deepEqual(outcome, { kind: 'EMPTY_GROUP' });
});

test('a fully ready applicant is ASSIGNED', async () => {
  const groupId = 'g1';
  const link = fakeLink(groupId, 'identity-1', 0);
  const { deps } = buildFakeDeps({ groupId, links: [link] });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);
  assert.equal(outcome.kind, 'COMPLETED');
  if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
  assert.equal(outcome.results.length, 1);
  assert.deepEqual(outcome.results[0]?.result, { status: 'ASSIGNED', batchName: '5.10-1', positionInBatch: 1 });
});

test('an applicant missing required fields is NOT_READY with the missing field names', async () => {
  const groupId = 'g1';
  const link = fakeLink(groupId, 'identity-1', 0);
  const { deps } = buildFakeDeps({
    groupId,
    links: [link],
    readData: async () => completeData({ email: '' }),
  });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);
  assert.equal(outcome.kind, 'COMPLETED');
  if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
  const result = outcome.results[0]?.result;
  assert.equal(result?.status, 'NOT_READY');
  if (result?.status !== 'NOT_READY') throw new Error('unreachable');
  assert.equal(result.reason, 'MISSING_FIELDS');
  assert.ok(result.missingFields?.includes('Email'));
});

test('an applicant with an invalid field (expired passport) is NOT_READY with that reason', async () => {
  const groupId = 'g1';
  const link = fakeLink(groupId, 'identity-1', 0);
  const { deps } = buildFakeDeps({
    groupId,
    links: [link],
    readData: async () => completeData({ passportExpiryDate: '2000-01-01' }),
  });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);
  assert.equal(outcome.kind, 'COMPLETED');
  if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
  assert.deepEqual(outcome.results[0]?.result, { status: 'NOT_READY', reason: 'PASSPORT_EXPIRED' });
});

test('a Sheet row that cannot be found (readVerifiedApplicantData returns null) is SHEET_ROW_NOT_FOUND, never treated as ready', async () => {
  const groupId = 'g1';
  const link = fakeLink(groupId, 'identity-1', 0);
  const { deps } = buildFakeDeps({
    groupId,
    links: [link],
    readData: async () => null,
  });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);
  assert.equal(outcome.kind, 'COMPLETED');
  if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
  assert.deepEqual(outcome.results[0]?.result, { status: 'SHEET_ROW_NOT_FOUND' });
});

test('a Sheet read that throws (e.g. Sheets API failure) is SHEET_READ_FAILED, never treated as ready, and never aborts the group', async () => {
  const groupId = 'g1';
  const brokenLink = fakeLink(groupId, 'identity-broken', 0);
  const okLink = fakeLink(groupId, 'identity-ok', 1);
  const { deps } = buildFakeDeps({
    groupId,
    links: [brokenLink, okLink],
    readData: async (_groupId, passportIdentityId) => {
      if (passportIdentityId === 'identity-broken') {
        throw new Error('Sheets API unavailable: simulated failure');
      }
      return completeData();
    },
  });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);
  assert.equal(outcome.kind, 'COMPLETED');
  if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
  assert.equal(outcome.results.length, 2, 'one applicant\'s Sheet failure never drops the rest of the group from the results');

  const brokenResult = outcome.results.find((r) => r.passportIdentityId === 'identity-broken');
  assert.equal(brokenResult?.result.status, 'SHEET_READ_FAILED');
  if (brokenResult?.result.status !== 'SHEET_READ_FAILED') throw new Error('unreachable');
  assert.match(brokenResult.result.message, /Sheets API unavailable/);

  const okResult = outcome.results.find((r) => r.passportIdentityId === 'identity-ok');
  assert.equal(okResult?.result.status, 'ASSIGNED');
});

test('one applicant failing validation does not block a different ready applicant in the same group', async () => {
  const groupId = 'g1';
  const notReadyLink = fakeLink(groupId, 'identity-not-ready', 0);
  const readyLink = fakeLink(groupId, 'identity-ready', 1);
  const { deps } = buildFakeDeps({
    groupId,
    links: [notReadyLink, readyLink],
    readData: async (_groupId, passportIdentityId) =>
      passportIdentityId === 'identity-not-ready' ? completeData({ passportNumber: '' }) : completeData(),
  });
  const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);
  assert.equal(outcome.kind, 'COMPLETED');
  if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
  assert.equal(outcome.results.find((r) => r.passportIdentityId === 'identity-not-ready')?.result.status, 'NOT_READY');
  assert.equal(outcome.results.find((r) => r.passportIdentityId === 'identity-ready')?.result.status, 'ASSIGNED');
});

// --- Hybrid tests: real DB-backed assignVisaBatch/findVisaBatchById, with
// the Sheets-reading layer faked (there is no real Google Sheet in tests,
// same convention tests/duplicates.processOperatorCommand.test.ts already
// uses for ensureSheet/upsertRow). These are the ones that actually prove
// the real batch-splitting and idempotency behavior end-to-end.

test('11 ready applicants in one group -> exactly 2 real batches (10 then 1), each result names its own batch', async () => {
  const { groupId } = await createGroup('2026-10-05');
  const identityIds: string[] = [];
  try {
    const links: PassportMessageLinkRecord[] = [];
    for (let i = 0; i < 11; i += 1) {
      const identityId = await createIdentity();
      identityIds.push(identityId);
      links.push(fakeLink(groupId, identityId, i));
    }

    const { deps } = buildFakeDeps({ groupId, departureDate: '2026-10-05', links, useRealAssign: true });
    const outcome = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps);

    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    assert.equal(outcome.results.length, 11);
    assert.ok(outcome.results.every((r) => r.result.status === 'ASSIGNED'));

    const batchNames = outcome.results.map((r) => (r.result.status === 'ASSIGNED' ? r.result.batchName : null));
    const batch1Count = batchNames.filter((name) => name === '5.10-1').length;
    const batch2Count = batchNames.filter((name) => name === '5.10-2').length;
    assert.equal(batch1Count, 10, 'first 10 applicants land in batch 5.10-1');
    assert.equal(batch2Count, 1, 'the 11th applicant opens batch 5.10-2');
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});

test('calling visaAssignCommand twice for the SAME group is safe -- no duplicate assignments, identical results', async () => {
  const { groupId } = await createGroup('2026-10-05');
  const identityIds: string[] = [];
  try {
    const links: PassportMessageLinkRecord[] = [];
    for (let i = 0; i < 3; i += 1) {
      const identityId = await createIdentity();
      identityIds.push(identityId);
      links.push(fakeLink(groupId, identityId, i));
    }

    const { deps: deps1 } = buildFakeDeps({ groupId, departureDate: '2026-10-05', links, useRealAssign: true });
    const first = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps1);

    const { deps: deps2 } = buildFakeDeps({ groupId, departureDate: '2026-10-05', links, useRealAssign: true });
    const second = await visaAssignCommand({ telegramChatId: 123, authorStatus: 'administrator' }, deps2);

    assert.equal(first.kind, 'COMPLETED');
    assert.equal(second.kind, 'COMPLETED');
    if (first.kind !== 'COMPLETED' || second.kind !== 'COMPLETED') throw new Error('unreachable');
    assert.deepEqual(first.results, second.results, 'the second run is a pure no-op that reports the exact same assignment per applicant');

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM visa_batch_applicants WHERE group_id = $1 AND status = 'active'`,
      [groupId],
    );
    assert.equal(rows[0]?.count, '3', 'exactly 3 rows exist -- the repeated call never created duplicates');
  } finally {
    await cleanupAll([groupId], identityIds);
  }
});
