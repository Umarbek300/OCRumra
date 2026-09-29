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

interface CreateSpreadsheetCallArgs {
  title: string;
  requestId: string;
  folderId: string;
}

function buildDeps(
  overrides: Partial<EnsureGroupSheetDependencies & { group: Group | null; secondFindGroup: Group | null }> = {},
): {
  deps: EnsureGroupSheetDependencies;
  calls: Calls;
  createSpreadsheetCalls: CreateSpreadsheetCallArgs[];
} {
  const calls: Calls = { findGroup: 0, setGoogleSheetId: 0, createSpreadsheet: 0, writeHeaderRow: 0, moveToFolder: 0 };
  const createSpreadsheetCalls: CreateSpreadsheetCallArgs[] = [];
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
      createSpreadsheet: async (title, requestId, folderId) => {
        calls.createSpreadsheet += 1;
        createSpreadsheetCalls.push({ title, requestId, folderId });
        return { spreadsheetId: `created-for-${title}` };
      },
      writeHeaderRow: async () => {
        calls.writeHeaderRow += 1;
      },
      moveToFolder: async () => {
        calls.moveToFolder += 1;
      },
    },
    getDriveFolderId: () => 'folder-xyz',
    ...overrides,
  };
  return { deps, calls, createSpreadsheetCalls };
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

test('ensureGroupSheet creates a new spreadsheet via the provisioning client, writes the header, and persists the id when none exists yet', async () => {
  const { deps, calls, createSpreadsheetCalls } = buildDeps({ getDriveFolderId: () => 'folder-xyz' });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(calls.createSpreadsheet, 1);
  assert.equal(calls.writeHeaderRow, 1);
  assert.equal(calls.setGoogleSheetId, 1);
  assert.equal(result.spreadsheetId, 'created-for-20 September 2026 — 2026-09-20');
  assert.deepEqual(createSpreadsheetCalls[0], {
    title: '20 September 2026 — 2026-09-20',
    requestId: 'group-1',
    folderId: 'folder-xyz',
  });
});

test('ensureGroupSheet passes the group id as the provisioning requestId (Apps Script idempotency key)', async () => {
  const { deps, createSpreadsheetCalls } = buildDeps({ getDriveFolderId: () => 'folder-xyz' });

  await ensureGroupSheet('group-1', deps);

  assert.equal(createSpreadsheetCalls[0]!.requestId, 'group-1');
});

test('ensureGroupSheet never calls moveToFolder -- the provisioning client (Apps Script) already places the file in the target folder', async () => {
  const { deps, calls } = buildDeps({ getDriveFolderId: () => 'folder-xyz' });

  await ensureGroupSheet('group-1', deps);

  assert.equal(calls.moveToFolder, 0);
});

test('ensureGroupSheet throws a clear error when no Drive folder is configured, without calling the provisioning client at all', async () => {
  const { deps, calls } = buildDeps({ getDriveFolderId: () => null });

  await assert.rejects(() => ensureGroupSheet('group-1', deps), /GOOGLE_SHEETS_DRIVE_FOLDER_ID is not configured/);
  assert.equal(calls.createSpreadsheet, 0);
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
  assert.equal(calls.moveToFolder, 0, 'no cleanup/move is attempted on the orphaned loser spreadsheet');
});

test('ensureGroupSheet throws if it loses the race and, unexpectedly, no winner is found either', async () => {
  const { deps } = buildDeps({
    setGoogleSheetId: async () => null,
    secondFindGroup: { ...BASE_GROUP, googleSheetId: null },
  });

  await assert.rejects(() => ensureGroupSheet('group-1', deps), /lost the sheet-creation race/);
});

// --- buildRealProvisioningClient: Apps Script provisioning + verification, and timeout propagation ---

test('buildRealProvisioningClient.createSpreadsheet calls the injected provision function and verifies the result via the service account', async () => {
  const seenProvisionRequest: { title?: string; folderId?: string; requestId?: string } = {};
  const seenTimeouts: Record<string, number | undefined> = {};

  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
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
        get: (async (params: { fileId: string }, options: { timeout?: number }) => {
          seenTimeouts['files.get'] = options?.timeout;
          return {
            data: {
              id: params.fileId,
              mimeType: 'application/vnd.google-apps.spreadsheet',
              parents: ['folder-xyz'],
              capabilities: { canEdit: true },
            },
          };
        }) as never,
        update: (async (_params: unknown, options: { timeout?: number }) => {
          seenTimeouts['files.update'] = options?.timeout;
          return { data: {} };
        }) as never,
      },
    } as never,
  };

  const fakeProvision = (async (request: { title: string; folderId: string; requestId: string }) => {
    seenProvisionRequest.title = request.title;
    seenProvisionRequest.folderId = request.folderId;
    seenProvisionRequest.requestId = request.requestId;
    return { spreadsheetId: 'apps-script-created-id' };
  }) as never;

  const client = buildRealProvisioningClient(() => fakeClients, fakeProvision);
  const { spreadsheetId } = await client.createSpreadsheet('Test Title', 'group-1', 'folder-xyz');
  await client.writeHeaderRow(spreadsheetId);
  await client.moveToFolder(spreadsheetId, 'folder-xyz');

  assert.equal(spreadsheetId, 'apps-script-created-id');
  assert.deepEqual(seenProvisionRequest, { title: 'Test Title', folderId: 'folder-xyz', requestId: 'group-1' });

  // No GOOGLE_SHEETS_API_TIMEOUT_MS is set in this test process's env, so
  // getConfiguredApiTimeoutMs() falls back to env.schema.ts's own 30000ms
  // default — proving the real, unmocked config path, not a test double.
  assert.equal(seenTimeouts['files.get'], 30_000);
  assert.equal(seenTimeouts['spreadsheets.values.update'], 30_000);
  assert.equal(seenTimeouts['files.update'], 30_000);
});

test('buildRealProvisioningClient.createSpreadsheet throws when the verified file is not inside the configured folder', async () => {
  const fakeClients: SheetsClients = {
    sheets: {} as never,
    drive: {
      files: {
        get: (async (params: { fileId: string }) => ({
          data: { id: params.fileId, mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['some-other-folder'], capabilities: { canEdit: true } },
        })) as never,
      },
    } as never,
  };
  const fakeProvision = (async () => ({ spreadsheetId: 'apps-script-created-id' })) as never;

  const client = buildRealProvisioningClient(() => fakeClients, fakeProvision);
  await assert.rejects(() => client.createSpreadsheet('Test Title', 'group-1', 'folder-xyz'), /not inside the configured Drive folder/);
});

test('buildRealProvisioningClient.createSpreadsheet throws when the service account does not have edit access', async () => {
  const fakeClients: SheetsClients = {
    sheets: {} as never,
    drive: {
      files: {
        get: (async (params: { fileId: string }) => ({
          data: { id: params.fileId, mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['folder-xyz'], capabilities: { canEdit: false } },
        })) as never,
      },
    } as never,
  };
  const fakeProvision = (async () => ({ spreadsheetId: 'apps-script-created-id' })) as never;

  const client = buildRealProvisioningClient(() => fakeClients, fakeProvision);
  await assert.rejects(() => client.createSpreadsheet('Test Title', 'group-1', 'folder-xyz'), /does not have edit access/);
});

test('buildRealProvisioningClient.createSpreadsheet throws when the verified file is not actually a spreadsheet', async () => {
  const fakeClients: SheetsClients = {
    sheets: {} as never,
    drive: {
      files: {
        get: (async (params: { fileId: string }) => ({
          data: { id: params.fileId, mimeType: 'application/vnd.google-apps.folder', parents: ['folder-xyz'], capabilities: { canEdit: true } },
        })) as never,
      },
    } as never,
  };
  const fakeProvision = (async () => ({ spreadsheetId: 'apps-script-created-id' })) as never;

  const client = buildRealProvisioningClient(() => fakeClients, fakeProvision);
  await assert.rejects(() => client.createSpreadsheet('Test Title', 'group-1', 'folder-xyz'), /it is not a spreadsheet/);
});
