import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Group } from '../src/db/repositories/groups.repo.js';
import type { PassportMessageLinkRecord } from '../src/db/repositories/passportMessageLinks.repo.js';
import type { SheetReconciliationJobRecord } from '../src/db/repositories/sheetReconciliation.repo.js';
import type { TelegramMessageRecord } from '../src/db/repositories/telegramMessages.repo.js';
import { reconcileSheetRow, type ReconcileSheetRowDependencies } from '../src/sheets/reconcileSheetRow.js';

const SAMPLE_JOB: SheetReconciliationJobRecord = {
  id: 'job-1',
  passportIdentityId: 'identity-1',
  groupId: 'group-1',
  expectedOldCanonicalTelegramMessageId: 'old-msg',
  sourceOperation: 'cancel_passport',
  sourceEventId: null,
  status: 'processing',
  attempts: 1,
  lastError: null,
  nextAttemptAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
};

function sampleMessage(id: string): TelegramMessageRecord {
  return {
    id,
    telegramChatId: '1',
    telegramMessageId: '1',
    telegramSenderUserId: '1',
    telegramSenderDisplayName: null,
    messageTimestamp: new Date().toISOString(),
    telegramPhotoFileId: 'FILE',
    source: 'photo',
    groupId: 'group-1',
    agentId: null,
    captionText: null,
    mediaGroupId: null,
    createdAt: new Date().toISOString(),
  };
}

function sampleLink(telegramMessageId: string): PassportMessageLinkRecord {
  return {
    id: 'link-1',
    passportIdentityId: 'identity-1',
    telegramMessageId,
    groupId: 'group-1',
    agentId: null,
    role: 'canonical',
    linkStatus: 'active',
    matchConfidenceTier: 'high',
    resolvedBy: 'auto',
    createdAt: new Date().toISOString(),
  };
}

function buildDeps(overrides: Partial<ReconcileSheetRowDependencies> = {}): {
  deps: ReconcileSheetRowDependencies;
  calls: { claim: number; markDone: number; markFailed: number; deleteRow: number; reassignRow: number; ensureSheet: number };
  markFailedArgs: { id: string; message: string }[];
} {
  const calls = { claim: 0, markDone: 0, markFailed: 0, deleteRow: 0, reassignRow: 0, ensureSheet: 0 };
  const markFailedArgs: { id: string; message: string }[] = [];

  const deps: ReconcileSheetRowDependencies = {
    claim: async (id) => {
      calls.claim += 1;
      return { ...SAMPLE_JOB, id };
    },
    markDone: async (id) => {
      calls.markDone += 1;
      return { ...SAMPLE_JOB, id, status: 'done' };
    },
    markFailed: async (id, message) => {
      calls.markFailed += 1;
      markFailedArgs.push({ id, message });
      return { ...SAMPLE_JOB, id, status: 'failed', lastError: message };
    },
    findActiveCanonicalLink: async () => null,
    ensureSheet: async (groupId) => {
      calls.ensureSheet += 1;
      return { spreadsheetId: `sheet-for-${groupId}` };
    },
    deleteRow: async () => {
      calls.deleteRow += 1;
      return { outcome: 'deleted', rowNumber: 3 };
    },
    reassignRow: async () => {
      calls.reassignRow += 1;
      return { outcome: 'reassigned', rowNumber: 3 };
    },
    findTelegramMessage: async (id) => sampleMessage(id),
    findOcrResult: async () => ({
      id: 'ocr-1',
      telegramMessageId: 'irrelevant',
      firstName: { value: 'JOHN', confidence: 'high' },
      middleName: { value: null, confidence: null },
      surname: { value: 'DOE', confidence: 'high' },
      passportNumber: { value: 'AB1234567', confidence: 'high' },
      dateOfBirth: { value: '1990-01-01', confidence: 'high' },
      passportIssueDate: { value: null, confidence: null },
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    findAgent: async () => null,
    findGroup: async () => null,
    ...overrides,
  };

  return { deps, calls, markFailedArgs };
}

test('reconcileSheetRow reassigns to the CURRENT canonical when one exists, re-resolved fresh, then marks done', async () => {
  let reassignArgs: unknown;
  const { deps, calls } = buildDeps({
    findActiveCanonicalLink: async () => sampleLink('new-msg'),
    reassignRow: async (input) => {
      reassignArgs = input;
      return { outcome: 'reassigned', rowNumber: 4 };
    },
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal(calls.deleteRow, 0);
  assert.equal(calls.markDone, 1);
  assert.deepEqual(reassignArgs, {
    spreadsheetId: 'sheet-for-group-1',
    oldCanonicalTelegramMessageId: 'old-msg',
    newCanonicalTelegramMessageId: 'new-msg',
    row: (reassignArgs as { row: unknown }).row,
    googleSheetGid: undefined,
  });
});

test('reconcileSheetRow deletes when NO current canonical exists, then marks done', async () => {
  let deleteArgs: unknown;
  const { deps, calls } = buildDeps({
    findActiveCanonicalLink: async () => null,
    deleteRow: async (input) => {
      deleteArgs = input;
      return { outcome: 'deleted', rowNumber: 3 };
    },
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal(calls.reassignRow, 0);
  assert.equal(calls.markDone, 1);
  assert.deepEqual(deleteArgs, {
    spreadsheetId: 'sheet-for-group-1',
    expectedCanonicalTelegramMessageId: 'old-msg',
    googleSheetGid: undefined,
  });
});

test('reconcileSheetRow treats a not_found delete result as success (already handled by an earlier job)', async () => {
  const { deps, calls } = buildDeps({
    findActiveCanonicalLink: async () => null,
    deleteRow: async () => ({ outcome: 'not_found' }),
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal(calls.markDone, 1);
  assert.equal(calls.markFailed, 0);
});

test('reconcileSheetRow treats a not_found reassign result as success (superseded by a later job\'s own fix)', async () => {
  const { deps, calls } = buildDeps({
    findActiveCanonicalLink: async () => sampleLink('new-msg'),
    reassignRow: async () => ({ outcome: 'not_found' }),
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal(calls.markDone, 1);
  assert.equal(calls.markFailed, 0);
});

test('reconcileSheetRow marks failed (with a computed backoff) when the Sheets call throws', async () => {
  const { deps, calls, markFailedArgs } = buildDeps({
    findActiveCanonicalLink: async () => null,
    deleteRow: async () => {
      throw new Error('Sheets API unavailable: simulated failure');
    },
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal(calls.markDone, 0);
  assert.equal(calls.markFailed, 1);
  assert.match(markFailedArgs[0]?.message ?? '', /Sheets API unavailable/);
});

test('reconcileSheetRow marks failed when it cannot build a row for the current canonical (missing message/OCR data)', async () => {
  const { deps, calls, markFailedArgs } = buildDeps({
    findActiveCanonicalLink: async () => sampleLink('new-msg'),
    findOcrResult: async () => null,
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal(calls.reassignRow, 0);
  assert.equal(calls.markFailed, 1);
  assert.match(markFailedArgs[0]?.message ?? '', /no message\/OCR data/);
});

test('reconcileSheetRow always deletes (never reassigns) for a merge-sourced job, even when a current canonical exists', async () => {
  let reassignCalled = false;
  const { deps, calls } = buildDeps({
    claim: async (id) => ({ ...SAMPLE_JOB, id, sourceOperation: 'merge' }),
    findActiveCanonicalLink: async () => sampleLink('some-other-already-synced-message'),
    reassignRow: async () => {
      reassignCalled = true;
      return { outcome: 'reassigned', rowNumber: 1 };
    },
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal(reassignCalled, false, 'merge-sourced jobs never reassign, regardless of the current canonical');
  assert.equal(calls.deleteRow, 1);
  assert.equal(calls.markDone, 1);
});

test('reconcileSheetRow does nothing further when the job is not claimable', async () => {
  const { deps, calls } = buildDeps({ claim: async () => null });

  await reconcileSheetRow('job-1', deps);

  assert.equal(calls.ensureSheet, 0);
  assert.equal(calls.deleteRow, 0);
  assert.equal(calls.reassignRow, 0);
  assert.equal(calls.markDone, 0);
  assert.equal(calls.markFailed, 0);
});

// --- M-2: master/tab architecture -- googleSheetGid wiring from findGroup into deleteRow/reassignRow ---

function masterTabGroup(gid: number): Group {
  return {
    id: 'group-1',
    name: 'Master/Tab Test Group',
    departureDate: '2026-09-20',
    telegramChatId: null,
    googleSheetId: 'master-abc',
    googleSheetGid: gid,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('M-2: a master/tab group\'s googleSheetGid (456789) is threaded into reassignRow when a current canonical exists', async () => {
  let reassignArgs: unknown;
  const { deps } = buildDeps({
    findGroup: async () => masterTabGroup(456789),
    findActiveCanonicalLink: async () => sampleLink('new-msg'),
    reassignRow: async (input) => {
      reassignArgs = input;
      return { outcome: 'reassigned', rowNumber: 4 };
    },
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal((reassignArgs as { googleSheetGid: number | null | undefined }).googleSheetGid, 456789);
});

test('M-2: a master/tab group\'s googleSheetGid (456789) is threaded into deleteRow when no current canonical exists', async () => {
  let deleteArgs: unknown;
  const { deps } = buildDeps({
    findGroup: async () => masterTabGroup(456789),
    findActiveCanonicalLink: async () => null,
    deleteRow: async (input) => {
      deleteArgs = input;
      return { outcome: 'deleted', rowNumber: 3 };
    },
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal((deleteArgs as { googleSheetGid: number | null | undefined }).googleSheetGid, 456789);
});

test('M-2: a master/tab group\'s googleSheetGid (456789) is threaded into deleteRow for a merge-sourced job too', async () => {
  let deleteArgs: unknown;
  const { deps } = buildDeps({
    claim: async (id) => ({ ...SAMPLE_JOB, id, sourceOperation: 'merge' }),
    findGroup: async () => masterTabGroup(456789),
    findActiveCanonicalLink: async () => sampleLink('some-other-already-synced-message'),
    deleteRow: async (input) => {
      deleteArgs = input;
      return { outcome: 'deleted', rowNumber: 1 };
    },
  });

  await reconcileSheetRow('job-1', deps);

  assert.equal((deleteArgs as { googleSheetGid: number | null | undefined }).googleSheetGid, 456789);
});
