import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGenderSummaryBlock } from '../src/sheets/buildGenderSummaryBlock.js';
import type { Group } from '../src/db/repositories/groups.repo.js';
import type { GroupGenderStats } from '../src/db/repositories/groupGenderStats.repo.js';

const GROUP: Pick<Group, 'name' | 'departureDate'> = { name: '20 September', departureDate: '2026-09-20' };

test('buildGenderSummaryBlock renders the title, total, male, female, and unspecified rows in order', () => {
  const stats: GroupGenderStats = { male: 28, female: 22, unspecified: 0, total: 50 };
  const rows = buildGenderSummaryBlock(GROUP, stats);

  assert.deepEqual(rows, [
    ['Guruh: 20 September — 2026-09-20', ''],
    ['Jami:', '50'],
    ['Erkak:', '28'],
    ['Ayol:', '22'],
    ["Noma'lum:", '0'],
  ]);
});

test('buildGenderSummaryBlock always renders exactly 5 rows of 2 columns each', () => {
  const stats: GroupGenderStats = { male: 0, female: 0, unspecified: 0, total: 0 };
  const rows = buildGenderSummaryBlock(GROUP, stats);

  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.length, 2);
  }
});

test('buildGenderSummaryBlock renders the exact total it was given — male + female + unspecified = total is GroupGenderStats\'s own invariant, not recomputed here', () => {
  const stats: GroupGenderStats = { male: 10, female: 15, unspecified: 3, total: 28 };
  const rows = buildGenderSummaryBlock(GROUP, stats);

  assert.equal(rows[1]![1], '28');
  assert.equal(Number(rows[2]![1]) + Number(rows[3]![1]) + Number(rows[4]![1]), 28);
});

test('buildGenderSummaryBlock includes the group name and departure date in the title row', () => {
  const rows = buildGenderSummaryBlock(
    { name: 'Samarqand tur guruhi', departureDate: '2026-10-01' },
    { male: 1, female: 1, unspecified: 0, total: 2 },
  );
  assert.match(rows[0]![0]!, /Samarqand tur guruhi/);
  assert.match(rows[0]![0]!, /2026-10-01/);
});
