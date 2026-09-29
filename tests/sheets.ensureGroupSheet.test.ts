import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRealProvisioningClient,
  buildSpreadsheetTitle,
  ensureGroupSheet,
  getConfiguredMasterSpreadsheetId,
  type EnsureGroupSheetDependencies,
} from '../src/sheets/ensureGroupSheet.js';
import type { AppsScriptEnsureTabResult } from '../src/sheets/appsScriptProvisioning.js';
import type { Group, GroupSheetTab } from '../src/db/repositories/groups.repo.js';
import type { SheetsClients } from '../src/sheets/sheetsAuth.js';

const BASE_GROUP: Group = {
  id: 'group-1',
  name: '20 September 2026',
  departureDate: '2026-09-20',
  telegramChatId: '-1001234567890',
  googleSheetId: null,
  googleSheetGid: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface Calls {
  findGroup: number;
  setGoogleSheetId: number;
  createSpreadsheet: number;
  writeHeaderRow: number;
  moveToFolder: number;
  provisionTab: number;
  setGroupSheetTab: number;
}

interface CreateSpreadsheetCallArgs {
  title: string;
  requestId: string;
  folderId: string;
}

interface ProvisionTabCallArgs {
  masterSpreadsheetId: string;
  tabTitle: string;
  requestId: string;
}

interface SetGroupSheetTabCallArgs {
  groupId: string;
  spreadsheetId: string;
  sheetId: number;
}

function buildDeps(
  overrides: Partial<EnsureGroupSheetDependencies & { group: Group | null; secondFindGroup: Group | null }> = {},
): {
  deps: EnsureGroupSheetDependencies;
  calls: Calls;
  createSpreadsheetCalls: CreateSpreadsheetCallArgs[];
  provisionTabCalls: ProvisionTabCallArgs[];
  setGroupSheetTabCalls: SetGroupSheetTabCallArgs[];
} {
  const calls: Calls = {
    findGroup: 0,
    setGoogleSheetId: 0,
    createSpreadsheet: 0,
    writeHeaderRow: 0,
    moveToFolder: 0,
    provisionTab: 0,
    setGroupSheetTab: 0,
  };
  const createSpreadsheetCalls: CreateSpreadsheetCallArgs[] = [];
  const provisionTabCalls: ProvisionTabCallArgs[] = [];
  const setGroupSheetTabCalls: SetGroupSheetTabCallArgs[] = [];
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
    setGroupSheetTab: async (groupId, spreadsheetId, sheetId): Promise<GroupSheetTab | null> => {
      calls.setGroupSheetTab += 1;
      setGroupSheetTabCalls.push({ groupId, spreadsheetId, sheetId });
      return { id: groupId, googleSheetId: spreadsheetId, googleSheetGid: sheetId };
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
    provisionTab: async ({ masterSpreadsheetId, tabTitle, requestId }): Promise<AppsScriptEnsureTabResult> => {
      calls.provisionTab += 1;
      provisionTabCalls.push({ masterSpreadsheetId, tabTitle, requestId });
      return { spreadsheetId: masterSpreadsheetId, sheetId: 918273645, title: tabTitle, created: true };
    },
    getDriveFolderId: () => 'folder-xyz',
    getMasterSpreadsheetId: () => null,
    ...overrides,
  };
  return { deps, calls, createSpreadsheetCalls, provisionTabCalls, setGroupSheetTabCalls };
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

// --- getConfiguredMasterSpreadsheetId ---

test('getConfiguredMasterSpreadsheetId returns null when unset', () => {
  assert.equal(getConfiguredMasterSpreadsheetId({}), null);
});

test('getConfiguredMasterSpreadsheetId returns the configured value when set', () => {
  assert.equal(getConfiguredMasterSpreadsheetId({ GOOGLE_SHEETS_MASTER_SPREADSHEET_ID: 'master-abc' }), 'master-abc');
});

// --- A. LEGACY (grandfathering) ---

test('A.1: legacy group with an existing google_sheet_id returns it without any provisioning, even with master env set', async () => {
  const { deps, calls } = buildDeps({
    group: { ...BASE_GROUP, googleSheetId: 'legacy-dedicated-file-id', googleSheetGid: null },
    getMasterSpreadsheetId: () => 'master-abc',
  });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(result.spreadsheetId, 'legacy-dedicated-file-id');
  assert.equal(calls.createSpreadsheet, 0);
  assert.equal(calls.provisionTab, 0);
  assert.equal(calls.setGroupSheetTab, 0);
});

test('A.2: legacy group without a spreadsheet and no master env configured uses the legacy provisioning flow', async () => {
  const { deps, calls } = buildDeps({ getMasterSpreadsheetId: () => null });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(calls.createSpreadsheet, 1);
  assert.equal(calls.writeHeaderRow, 1);
  assert.equal(calls.setGoogleSheetId, 1);
  assert.equal(calls.provisionTab, 0);
  assert.ok(result.spreadsheetId.startsWith('created-for-'));
});

test('A.3: existing legacy group is never migrated onto the master architecture once master env becomes set', async () => {
  const { deps, calls } = buildDeps({
    group: { ...BASE_GROUP, googleSheetId: 'legacy-dedicated-file-id', googleSheetGid: null },
    getMasterSpreadsheetId: () => 'master-abc',
  });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(result.spreadsheetId, 'legacy-dedicated-file-id', 'unchanged -- still the legacy dedicated file');
  assert.equal(calls.provisionTab, 0, 'ensureTab is never called for an already-provisioned legacy group');
});

// --- B. MASTER/TAB ---

test('B.4/5/6: a brand-new group with master env set calls provisionTab with the correct masterSpreadsheetId and tab title', async () => {
  const { deps, provisionTabCalls } = buildDeps({ getMasterSpreadsheetId: () => 'master-abc' });

  await ensureGroupSheet('group-1', deps);

  assert.equal(provisionTabCalls.length, 1);
  assert.deepEqual(provisionTabCalls[0], {
    masterSpreadsheetId: 'master-abc',
    tabTitle: '20 September 2026 — 2026-09-20',
    requestId: 'group-1',
  });
});

test('B.7/8: a successful ensureTab response is persisted via setGroupSheetTab with spreadsheetId + sheetId, and returned', async () => {
  const { deps, calls, setGroupSheetTabCalls } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    provisionTab: async () => ({ spreadsheetId: 'master-abc', sheetId: 555666777, title: '20 September 2026 — 2026-09-20', created: true }),
  });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(calls.setGroupSheetTab, 1);
  assert.deepEqual(setGroupSheetTabCalls[0], { groupId: 'group-1', spreadsheetId: 'master-abc', sheetId: 555666777 });
  assert.equal(result.spreadsheetId, 'master-abc');
});

test('B.9: a group that already has both google_sheet_id and google_sheet_gid never triggers a new ensureTab call', async () => {
  const { deps, calls } = buildDeps({
    group: { ...BASE_GROUP, googleSheetId: 'master-abc', googleSheetGid: 111 },
    getMasterSpreadsheetId: () => 'master-abc',
  });

  const result = await ensureGroupSheet('group-1', deps);

  assert.equal(result.spreadsheetId, 'master-abc');
  assert.equal(calls.provisionTab, 0);
  assert.equal(calls.setGroupSheetTab, 0);
});

test('B.10: an Apps Script ensureTab failure never reaches setGroupSheetTab -- no master/gid is persisted', async () => {
  const { deps, calls } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    provisionTab: async () => {
      throw new Error('Apps Script ensureTab request failed: simulated network error');
    },
  });

  await assert.rejects(() => ensureGroupSheet('group-1', deps), /simulated network error/);
  assert.equal(calls.setGroupSheetTab, 0);
});

test('B.11: a DB update (setGroupSheetTab) failure after a successful ensureTab is surfaced clearly, naming the partial state', async () => {
  const { deps } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    provisionTab: async () => ({ spreadsheetId: 'master-abc', sheetId: 999, title: '20 September 2026 — 2026-09-20', created: true }),
    setGroupSheetTab: async () => null, // e.g. the group row vanished between findGroup and this write
  });

  await assert.rejects(
    () => ensureGroupSheet('group-1', deps),
    /Apps Script ensureTab succeeded.*spreadsheetId=master-abc.*sheetId=999.*manual reconciliation is required/is,
  );
});

test('B.11b: a thrown (not just null-returning) setGroupSheetTab failure is never swallowed', async () => {
  const { deps } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    setGroupSheetTab: async () => {
      throw new Error('simulated DB connection error');
    },
  });

  await assert.rejects(() => ensureGroupSheet('group-1', deps), /simulated DB connection error/);
});

test('B.12: master env unset falls back entirely to the legacy path (no provisionTab call)', async () => {
  const { deps, calls } = buildDeps({ getMasterSpreadsheetId: () => null });

  await ensureGroupSheet('group-1', deps);

  assert.equal(calls.provisionTab, 0);
  assert.equal(calls.createSpreadsheet, 1);
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
