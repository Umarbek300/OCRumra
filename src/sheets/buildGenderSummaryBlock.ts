import type { Group } from '../db/repositories/groups.repo.js';
import type { GroupGenderStats } from '../db/repositories/groupGenderStats.repo.js';

/**
 * Builds the 5-row O:P summary block (see genderSummaryLayout.ts) from a
 * group's identity and its already-computed gender stats. Pure and
 * side-effect free -- no DB query, no Sheets API call. total is always
 * male + female + unspecified, by GroupGenderStats's own construction
 * (computeGroupGenderStats never computes it independently), so this
 * function cannot itself introduce a mismatch between the displayed total
 * and the displayed breakdown.
 */
export function buildGenderSummaryBlock(group: Pick<Group, 'name' | 'departureDate'>, stats: GroupGenderStats): string[][] {
  return [
    [`Guruh: ${group.name} — ${group.departureDate}`, ''],
    ['Jami:', String(stats.total)],
    ['Erkak:', String(stats.male)],
    ['Ayol:', String(stats.female)],
    ["Noma'lum:", String(stats.unspecified)],
  ];
}
