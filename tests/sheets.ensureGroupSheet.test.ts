import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRealProvisioningClient, buildSpreadsheetTitle, ensureGroupSheet, type EnsureGroupSheetDependencies } from '../src/sheets/ensureGroupSheet.js';
import type { Group } from '../src/db/repositories/groups.repo.js';
import type { SheetsClients } from '../src/sheets/sheetsAuth.js';

const BASE_GROUP: Group = {
  id: 'group-1',
  name: '20 September 2026',
  departureDate: '2026-09-20',
  telegramChatId: '-1001234567890',
  googleSheetId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface Calls {
  findGroup: number;
  setGoogleSheetId: number;
  createSpreadsheet: number;
  writeHeaderRow: number;
  moveToFolder: number;
}

function buildDeps(overrides: Partial<EnsureGroupSheetDependencies & { group: Group | null; secondFindGroup: Group | null }> = {}): {
  deps: EnsureGroupSheetDependencies;
  calls: Calls;
} {
  const calls: Calls = { findGroup: 0, setGoogleSheetId: 0, createSpreadsheet: 0, writeHeaderRow: 0, moveToFolder: 0 };
  const group = overrides.group !== undefined ? overrides.group : BASE_GROUP;

  const deps: EnsureGroupSheetDependencies = {
    findGroup: async () => {
      calls.findGroup += 1;
      if (calls.findGroup > 1 && overrides.secondFindGroup !== undefined) return overrides.secondFindGroup;
      return group;
    },
    setGoogleSheetId: async (_groupId, googleSheetId) => {
      calls.setGoogleSheetId += 1;
      return { ...BASE_GROUP, googleSheetId };
    },
    provisioningClient: {
      createSpreadsheet: async (title) => {
        calls.createSpreadsheet += 1;
        return { spreadsheetId: `created-for-${title}` };
      },
      writeHeaderRow: async () => {
        calls.writeHeaderRow += 1;
      },
      moveToFolder: async () => {
        calls.moveToFolder += 1;
      },
    },
    getDriveFolderId: () => null,
    ...overrides,
  };
  return { deps, calls };
}

test('buildSpreadsheetTitle combines name and departure date, stripping embedded newlines', () => {
  const title = buildSpreadsheetTitle({ name: '20\nSeptember\t2026', departureDate: '2026-09-20' });
  assert.equal(title, '20 September 2026 — 2026-09-20');
});

test('buildSpreadsheetTitle caps an absurdly long name to a bounded length', () => {
  const title = buildSpreadsheetTitle({ name: 'X'.repeat(500), departureDate: '2026-09-20' });
  assert.ok(title.length <= 200);
});

test('ensureGroupSheet returns the existing spreadsheet id without any provisioning calls', async () => {
  const { deps, calls } = buildDeps({ group: { ...BASE_GROUP, googleSheetId: 'existing-sheet-id' } });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(result.spreadsheetId, 'existing-sheet-id');
  assert.equal(calls.createSpreadsheet, 0);
  assert.equal(calls.writeHeaderRow, 0);
  assert.equal(calls.setGoogleSheetId, 0);
});

test('ensureGroupSheet creates a new spreadsheet, writes the header, and persists the id when none exists yet', async () => {
  const { deps, calls } = buildDeps();

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(calls.createSpreadsheet, 1);
  assert.equal(calls.writeHeaderRow, 1);
  assert.equal(calls.setGoogleSheetId, 1);
  assert.equal(result.spreadsheetId, 'created-for-20 September 2026 — 2026-09-20');
});

test('ensureGroupSheet moves the new spreadsheet into the configured Drive folder when one is set', async () => {
  const { deps, calls } = buildDeps({ getDriveFolderId: () => 'folder-xyz' });

  await ensureGroupSheet('group-1', deps);

  assert.equal(calls.moveToFolder, 1);
});

test('ensureGroupSheet never calls moveToFolder when no Drive folder is configured', async () => {
  const { deps, calls } = buildDeps({ getDriveFolderId: () => null });

  await ensureGroupSheet('group-1', deps);

  assert.equal(calls.moveToFolder, 0);
});

test('ensureGroupSheet throws a clear error when the group does not exist', async () => {
  const { deps } = buildDeps({ group: null });

  await assert.rejects(() => ensureGroupSheet('missing-group', deps), /no group found for id missing-group/);
});

test('ensureGroupSheet falls back to the winning spreadsheet id when it loses the creation race', async () => {
  const { deps, calls } = buildDeps({
    setGoogleSheetId: async () => {
      calls.setGoogleSheetId += 1;
      return null; // another caller's UPDATE ... WHERE google_sheet_id IS NULL already won
    },
    secondFindGroup: { ...BASE_GROUP, googleSheetId: 'winner-sheet-id' },
  });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(result.spreadsheetId, 'winner-sheet-id');
  assert.equal(calls.createSpreadsheet, 1, 'this caller still created (and orphaned) its own spreadsheet');
  assert.equal(calls.findGroup, 2, 'must re-read the group after losing the race');
});

test('ensureGroupSheet throws if it loses the race and, unexpectedly, no winner is found either', async () => {
  const { deps } = buildDeps({
    setGoogleSheetId: async () => null,
    secondFindGroup: { ...BASE_GROUP, googleSheetId: null },
  });

  await assert.rejects(() => ensureGroupSheet('group-1', deps), /lost the sheet-creation race/);
});

// --- buildRealProvisioningClient: timeout actually reaches the real gaxios call options ---

test('buildRealProvisioningClient passes the configured API timeout to every real Sheets/Drive call it makes', async () => {
  const seenTimeouts: Record<string, number | undefined> = {};

  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        create: (async (_params: unknown, options: { timeout?: number }) => {
          seenTimeouts['spreadsheets.create'] = options?.timeout;
          return { data: { spreadsheetId: 'fake-spreadsheet-id' } };
        }) as never,
        values: {
          update: (async (_params: unknown, options: { timeout?: number }) => {
            seenTimeouts['spreadsheets.values.update'] = options?.timeout;
            return { data: {} };
          }) as never,
        },
      },
    } as never,
    drive: {
      files: {
        get: (async (_params: unknown, options: { timeout?: number }) => {
          seenTimeouts['files.get'] = options?.timeout;
          return { data: { parents: ['old-parent-id'] } };
        }) as never,
        update: (async (_params: unknown, options: { timeout?: number }) => {
          seenTimeouts['files.update'] = options?.timeout;
          return { data: {} };
        }) as never,
      },
    } as never,
  };

  const client = buildRealProvisioningClient(() => fakeClients);
  const { spreadsheetId } = await client.createSpreadsheet('Test Title');
  await client.writeHeaderRow(spreadsheetId);
  await client.moveToFolder(spreadsheetId, 'folder-xyz');

  // No GOOGLE_SHEETS_API_TIMEOUT_MS is set in this test process's env, so
  // getConfiguredApiTimeoutMs() falls back to env.schema.ts's own 30000ms
  // default — proving the real, unmocked config path, not a test double.
  assert.equal(seenTimeouts['spreadsheets.create'], 30_000);
  assert.equal(seenTimeouts['spreadsheets.values.update'], 30_000);
  assert.equal(seenTimeouts['files.get'], 30_000);
  assert.equal(seenTimeouts['files.update'], 30_000);
});
