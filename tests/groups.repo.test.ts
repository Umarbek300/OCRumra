import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { findGroupById, setGroupSheetTab } from '../src/db/repositories/groups.repo.js';

// This exercises setGroupSheetTab's real SQL against a real Postgres
// instance -- the same "one file per repo function gets a real-DB test"
// convention as groupGenderStats.repo.test.ts and sheetSyncQueue.repo.test.ts.
//
// setGroupSheetTab is not yet called from any production path (it is only
// the repository-layer write for the target "one master file, one tab per
// group" architecture) -- these tests exercise it directly.

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}

async function createTestGroup(name = 'Sheet Tab Test Group'): Promise<string> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, '2026-09-20', uniqueChatId()],
  );
  assert.ok(group);
  return group.id;
}

// 1 & 2 & 3: both fields are written, with the correct values.
test('setGroupSheetTab writes google_sheet_id and google_sheet_gid for the given group', async () => {
  const groupId = await createTestGroup();

  const result = await setGroupSheetTab(groupId, 'master-spreadsheet-abc', 918273645);

  assert.ok(result);
  assert.equal(result.id, groupId);
  assert.equal(result.googleSheetId, 'master-spreadsheet-abc');
  assert.equal(result.googleSheetGid, 918273645);
  assert.equal(typeof result.googleSheetGid, 'number', 'gid must come back as a number, not a string');

  // Confirm it was actually persisted, not just echoed back.
  const reloaded = await findGroupById(groupId);
  assert.ok(reloaded);
  assert.equal(reloaded.googleSheetId, 'master-spreadsheet-abc');
});

// 4: other groups are never touched.
test('setGroupSheetTab never touches a different group\'s row', async () => {
  const groupIdA = await createTestGroup('Sheet Tab Test Group A');
  const groupIdB = await createTestGroup('Sheet Tab Test Group B');

  await setGroupSheetTab(groupIdA, 'master-spreadsheet-abc', 111);
  await setGroupSheetTab(groupIdB, 'master-spreadsheet-abc', 222);

  const reloadedA = await findGroupById(groupIdA);
  const reloadedB = await findGroupById(groupIdB);
  assert.ok(reloadedA);
  assert.ok(reloadedB);
  assert.equal(reloadedA.googleSheetId, 'master-spreadsheet-abc');
  assert.equal(reloadedB.googleSheetId, 'master-spreadsheet-abc');

  // Directly verify each row's own gid independently, proving the WHERE
  // clause scoped the UPDATE to exactly one row each time.
  const {
    rows: [rowA],
  } = await pool.query<{ google_sheet_gid: number }>('SELECT google_sheet_gid FROM groups WHERE id = $1', [groupIdA]);
  const {
    rows: [rowB],
  } = await pool.query<{ google_sheet_gid: number }>('SELECT google_sheet_gid FROM groups WHERE id = $1', [groupIdB]);
  assert.ok(rowA);
  assert.ok(rowB);
  assert.equal(rowA.google_sheet_gid, 111);
  assert.equal(rowB.google_sheet_gid, 222);
});

// 5: group not found -> null, no throw (same convention as findGroupById/createGroup).
test('setGroupSheetTab returns null when groupId does not match any row', async () => {
  const result = await setGroupSheetTab('00000000-0000-0000-0000-000000000000', 'master-spreadsheet-abc', 1);
  assert.equal(result, null);
});

// 6: a single atomic UPDATE -- calling it again later (e.g. to repoint a
// group at a different gid) succeeds and overwrites both fields together,
// unlike setGroupGoogleSheetId's one-time IS NULL claim guard.
test('setGroupSheetTab is a plain idempotent write, callable again to repoint both fields atomically', async () => {
  const groupId = await createTestGroup();

  const first = await setGroupSheetTab(groupId, 'master-spreadsheet-abc', 111);
  assert.ok(first);
  assert.equal(first.googleSheetGid, 111);

  const second = await setGroupSheetTab(groupId, 'master-spreadsheet-xyz', 999);
  assert.ok(second, 'a second call is never blocked -- no IS NULL guard on this function');
  assert.equal(second.googleSheetId, 'master-spreadsheet-xyz');
  assert.equal(second.googleSheetGid, 999);

  const reloaded = await findGroupById(groupId);
  assert.ok(reloaded);
  assert.equal(reloaded.googleSheetId, 'master-spreadsheet-xyz', 'both columns changed together in one statement');
});

// Legacy setGroupGoogleSheetId's semantics/behavior must remain completely
// untouched by this change -- its own one-time IS NULL claim guard still
// applies, independent of google_sheet_gid.
test('legacy setGroupGoogleSheetId behavior is unaffected by setGroupSheetTab existing', async () => {
  const { setGroupGoogleSheetId } = await import('../src/db/repositories/groups.repo.js');
  const groupId = await createTestGroup();

  const first = await setGroupGoogleSheetId(groupId, 'legacy-dedicated-file-id');
  assert.ok(first);
  assert.equal(first.googleSheetId, 'legacy-dedicated-file-id');

  const second = await setGroupGoogleSheetId(groupId, 'some-other-id');
  assert.equal(second, null, 'still refuses to overwrite an already-set google_sheet_id, exactly as before');
});

after(async () => {
  await pool.end();
});
