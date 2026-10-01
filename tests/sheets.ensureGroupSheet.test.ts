import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRealProvisioningClient,
  buildSpreadsheetTitle,
  buildTabTitle,
  ensureGroupSheet,
  getConfiguredMasterSpreadsheetId,
  type EnsureGroupSheetDependencies,
} from '../src/sheets/ensureGroupSheet.js';
import type { AppsScriptEnsureTabResult } from '../src/sheets/appsScriptProvisioning.js';
import type { Group, GroupSheetTab } from '../src/db/repositories/groups.repo.js';
import type { SheetsClients } from '../src/sheets/sheetsAuth.js';
import { SHEET_HEADER_ROW } from '../src/sheets/sheetLayout.js';

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

interface WriteHeaderRowCallArgs {
  spreadsheetId: string;
  sheetTitle: string | undefined;
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
  writeHeaderRowCalls: WriteHeaderRowCallArgs[];
  callOrder: string[];
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
  const writeHeaderRowCalls: WriteHeaderRowCallArgs[] = [];
  const callOrder: string[] = [];
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
      callOrder.push('setGroupSheetTab');
      setGroupSheetTabCalls.push({ groupId, spreadsheetId, sheetId });
      return { id: groupId, googleSheetId: spreadsheetId, googleSheetGid: sheetId };
    },
    provisioningClient: {
      createSpreadsheet: async (title, requestId, folderId) => {
        calls.createSpreadsheet += 1;
        createSpreadsheetCalls.push({ title, requestId, folderId });
        return { spreadsheetId: `created-for-${title}` };
      },
      writeHeaderRow: async (spreadsheetId, sheetTitle) => {
        calls.writeHeaderRow += 1;
        callOrder.push('writeHeaderRow');
        writeHeaderRowCalls.push({ spreadsheetId, sheetTitle });
      },
      moveToFolder: async () => {
        calls.moveToFolder += 1;
      },
    },
    provisionTab: async ({ masterSpreadsheetId, tabTitle, requestId }): Promise<AppsScriptEnsureTabResult> => {
      calls.provisionTab += 1;
      callOrder.push('provisionTab');
      provisionTabCalls.push({ masterSpreadsheetId, tabTitle, requestId });
      return { spreadsheetId: masterSpreadsheetId, sheetId: 918273645, title: tabTitle, created: true };
    },
    getDriveFolderId: () => 'folder-xyz',
    getMasterSpreadsheetId: () => null,
    listMasterSpreadsheetTabTitles: async () => [],
    ...overrides,
  };
  return { deps, calls, createSpreadsheetCalls, provisionTabCalls, setGroupSheetTabCalls, writeHeaderRowCalls, callOrder };
}

test('buildSpreadsheetTitle combines name and departure date, stripping embedded newlines', () => {
  const title = buildSpreadsheetTitle({ name: '20\nSeptember\t2026', departureDate: '2026-09-20' });
  assert.equal(title, '20 September 2026 — 2026-09-20');
});

test('buildSpreadsheetTitle caps an absurdly long name to a bounded length', () => {
  const title = buildSpreadsheetTitle({ name: 'X'.repeat(500), departureDate: '2026-09-20' });
  assert.ok(title.length <= 200);
});

// --- buildTabTitle: the master/tab path's tab title -- group name alone, no date suffix ---

test('buildTabTitle uses the group name alone, with no departure-date suffix', () => {
  const title = buildTabTitle({ id: 'group-1', name: '6 Oktyabr 2026' }, []);
  assert.equal(title, '6 Oktyabr 2026');
});

test('buildTabTitle strips embedded newlines/tabs and collapses whitespace, same as buildSpreadsheetTitle', () => {
  const title = buildTabTitle({ id: 'group-1', name: '6\nOktyabr\t2026' }, []);
  assert.equal(title, '6 Oktyabr 2026');
});

test('buildTabTitle replaces Google Sheets\' forbidden tab-title characters ([ ] * ? : / \\) with a safe character', () => {
  const title = buildTabTitle({ id: 'group-1', name: 'Group [A]: Tour/Trip? *Special*' }, []);
  for (const forbidden of ['[', ']', '*', '?', ':', '/', '\\']) {
    assert.ok(!title.includes(forbidden), `must not contain "${forbidden}"`);
  }
});

test('buildTabTitle falls back to a placeholder name when the group name is empty or whitespace-only', () => {
  assert.equal(buildTabTitle({ id: 'group-1', name: '   ' }, []), 'Untitled group');
  assert.equal(buildTabTitle({ id: 'group-1', name: '' }, []), 'Untitled group');
});

test('buildTabTitle caps an absurdly long name to Google Sheets\' 100-character tab-title limit', () => {
  const title = buildTabTitle({ id: 'group-1', name: 'X'.repeat(500) }, []);
  assert.ok(title.length <= 100);
});

test('buildTabTitle appends a short, stable, group-id-derived suffix only when the plain name collides with an existing tab title', () => {
  const noCollision = buildTabTitle({ id: 'group-1', name: '6 Oktyabr 2026' }, ['Some other tab']);
  assert.equal(noCollision, '6 Oktyabr 2026', 'no collision -- plain name used as-is');

  const collision = buildTabTitle({ id: 'abcdef12-3456-7890-abcd-ef1234567890', name: '6 Oktyabr 2026' }, ['6 Oktyabr 2026']);
  assert.equal(collision, '6 Oktyabr 2026 (abcdef12)');
});

test('buildTabTitle\'s collision suffix is deterministic -- the same group always gets the same suffix, never randomized per call', () => {
  const group = { id: 'abcdef12-3456-7890-abcd-ef1234567890', name: '6 Oktyabr 2026' };
  const first = buildTabTitle(group, ['6 Oktyabr 2026']);
  const second = buildTabTitle(group, ['6 Oktyabr 2026']);
  assert.equal(first, second);
});

test('buildTabTitle never uses the departure date as a disambiguating suffix, even on collision', () => {
  const title = buildTabTitle({ id: 'group-1', name: '6 Oktyabr 2026' }, ['6 Oktyabr 2026']);
  assert.ok(!title.includes('2026-'), 'must never contain an ISO-style date suffix');
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
  const { deps, calls, createSpreadsheetCalls, writeHeaderRowCalls } = buildDeps({ getDriveFolderId: () => 'folder-xyz' });

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
  assert.equal(
    writeHeaderRowCalls[0]!.sheetTitle,
    undefined,
    'legacy path: no sheetTitle -- targets the spreadsheet default/first sheet, unchanged behavior',
  );
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

test('B.4/5/6: a brand-new group with master env set calls provisionTab with the correct masterSpreadsheetId and tab title (the group name alone, no date suffix)', async () => {
  const { deps, provisionTabCalls } = buildDeps({ getMasterSpreadsheetId: () => 'master-abc' });

  await ensureGroupSheet('group-1', deps);

  assert.equal(provisionTabCalls.length, 1);
  assert.deepEqual(provisionTabCalls[0], {
    masterSpreadsheetId: 'master-abc',
    tabTitle: '20 September 2026',
    requestId: 'group-1',
  });
});

test('B.4b: when the plain group-name tab title collides with an existing tab in the master spreadsheet, ensureGroupSheet sends the disambiguated (suffixed) title to provisionTab', async () => {
  const { deps, provisionTabCalls } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    listMasterSpreadsheetTabTitles: async (masterSpreadsheetId) => {
      assert.equal(masterSpreadsheetId, 'master-abc');
      return ['20 September 2026', 'Some other tab'];
    },
  });

  await ensureGroupSheet('group-1', deps);

  assert.equal(provisionTabCalls[0]!.tabTitle, `20 September 2026 (${'group-1'.slice(0, 8)})`);
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

// --- M-1: master/tab header-row write ---

test('M-1.1: master/tab path writes the header row into the newly provisioned tab, using the tab title Apps Script returned -- never sheets[0]', async () => {
  const { deps, calls, writeHeaderRowCalls } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    provisionTab: async () => ({ spreadsheetId: 'master-abc', sheetId: 555666777, title: '20 September 2026 — 2026-09-20', created: true }),
  });

  await ensureGroupSheet('group-1', deps);

  assert.equal(calls.writeHeaderRow, 1);
  assert.deepEqual(writeHeaderRowCalls[0], { spreadsheetId: 'master-abc', sheetTitle: '20 September 2026 — 2026-09-20' });
});

test('M-1.2: the header row is written BEFORE the gid is persisted via setGroupSheetTab, never after', async () => {
  const { deps, callOrder } = buildDeps({ getMasterSpreadsheetId: () => 'master-abc' });

  await ensureGroupSheet('group-1', deps);

  assert.deepEqual(callOrder, ['provisionTab', 'writeHeaderRow', 'setGroupSheetTab']);
});

test('M-1.3: a header-write failure propagates and never reaches setGroupSheetTab -- no gid is persisted for a tab whose header write is unconfirmed', async () => {
  const { deps, calls } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    provisioningClient: {
      createSpreadsheet: async () => ({ spreadsheetId: 'unused' }),
      writeHeaderRow: async () => {
        throw new Error('writeHeaderRow (spreadsheets.values.update) failed: simulated API error');
      },
      moveToFolder: async () => {},
    },
  });

  await assert.rejects(() => ensureGroupSheet('group-1', deps), /simulated API error/);
  assert.equal(calls.setGroupSheetTab, 0);
});

test('M-1.4: a retry after a header-write failure re-provisions (idempotent) and re-attempts the header write, then succeeds', async () => {
  let writeHeaderAttempt = 0;
  const { deps, calls } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    provisioningClient: {
      createSpreadsheet: async () => ({ spreadsheetId: 'unused' }),
      writeHeaderRow: async () => {
        writeHeaderAttempt += 1;
        if (writeHeaderAttempt === 1) {
          throw new Error('simulated transient API error');
        }
      },
      moveToFolder: async () => {},
    },
  });

  await assert.rejects(() => ensureGroupSheet('group-1', deps), /simulated transient API error/);
  assert.equal(calls.setGroupSheetTab, 0, 'first attempt: header failed, nothing persisted');
  assert.equal(writeHeaderAttempt, 1, 'first attempt made exactly one header-write attempt');

  // Same group, still no google_sheet_id persisted (deps.group is unchanged) -- ensureGroupSheet
  // re-enters the master/tab path exactly as it would on a real retry.
  await ensureGroupSheet('group-1', deps);
  assert.equal(calls.provisionTab, 2, 'provisionTab is idempotent -- safe to call again on retry');
  assert.equal(writeHeaderAttempt, 2, 'header write is retried, not skipped, once persistence never happened');
  assert.equal(calls.setGroupSheetTab, 1, 'second attempt: header succeeded, gid is now persisted');
});

test('M-1.5: the header row uses the exact SHEET_HEADER_ROW values via buildRealProvisioningClient, scoped to the tab title (not the spreadsheet default sheet)', async () => {
  const seenUpdateCalls: { range?: string; values?: unknown }[] = [];
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          update: (async (params: { range: string; requestBody: { values: unknown } }) => {
            seenUpdateCalls.push({ range: params.range, values: params.requestBody.values });
            return { data: {} };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealProvisioningClient(() => fakeClients);
  await client.writeHeaderRow('master-abc', '20 September 2026 — 2026-09-20');

  assert.equal(seenUpdateCalls.length, 1);
  assert.equal(seenUpdateCalls[0]!.range, "'20 September 2026 — 2026-09-20'!A1:M1");
  assert.deepEqual(seenUpdateCalls[0]!.values, [SHEET_HEADER_ROW]);
});

test("M-1.6: buildRealProvisioningClient.writeHeaderRow with no sheetTitle targets the bare A1:M1 range -- unchanged legacy behavior", async () => {
  const seenUpdateCalls: { range?: string }[] = [];
  const fakeClients: SheetsClients = {
    sheets: {
      spreadsheets: {
        values: {
          update: (async (params: { range: string }) => {
            seenUpdateCalls.push({ range: params.range });
            return { data: {} };
          }) as never,
        },
      },
    } as never,
    drive: {} as never,
  };

  const client = buildRealProvisioningClient(() => fakeClients);
  await client.writeHeaderRow('legacy-spreadsheet-id');

  assert.equal(seenUpdateCalls[0]!.range, 'A1:M1');
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
  assert.equal(calls.writeHeaderRow, 0, 'the header is never written for a tab that was never actually provisioned');
});

test('B.11: a DB update (setGroupSheetTab) failure after a successful ensureTab is surfaced clearly, naming the partial state', async () => {
  const { deps, calls } = buildDeps({
    getMasterSpreadsheetId: () => 'master-abc',
    provisionTab: async () => ({ spreadsheetId: 'master-abc', sheetId: 999, title: '20 September 2026 — 2026-09-20', created: true }),
    setGroupSheetTab: async () => null, // e.g. the group row vanished between findGroup and this write
  });

  await assert.rejects(
    () => ensureGroupSheet('group-1', deps),
    /Apps Script ensureTab succeeded.*spreadsheetId=master-abc.*sheetId=999.*manual reconciliation is required/is,
  );
  assert.equal(calls.writeHeaderRow, 1, 'the header IS written before this persistence failure -- part of the documented partial state');
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
