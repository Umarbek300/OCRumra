import { pool } from '../pool.js';

export interface Group {
  id: string;
  name: string;
  departureDate: string;
  telegramChatId: string | null;
  googleSheetId: string | null;
  /**
   * NULL means this group is still on the legacy one-dedicated-file model
   * (or has no spreadsheet yet). Non-null means google_sheet_id holds the
   * shared master spreadsheet's id and this is the group's tab's stable
   * gid within it -- see setGroupSheetTab's own doc comment.
   */
  googleSheetGid: number | null;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow {
  id: string;
  name: string;
  departure_date: string;
  telegram_chat_id: string | null;
  google_sheet_id: string | null;
  google_sheet_gid: number | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    departureDate: row.departure_date,
    telegramChatId: row.telegram_chat_id,
    googleSheetId: row.google_sheet_id,
    googleSheetGid: row.google_sheet_gid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findGroupByTelegramChatId(telegramChatId: number): Promise<Group | null> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, google_sheet_gid, created_at, updated_at
     FROM groups WHERE telegram_chat_id = $1`,
    [telegramChatId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Idempotent create for automatic group registration (see
 * ensureGroupRegistered.ts) -- returns null if a group with this
 * telegram_chat_id already exists, via the same ON CONFLICT DO NOTHING
 * idiom used throughout this schema, so a concurrent race between two
 * ingests for a brand-new chat can never create two group rows. Unlike
 * the admin CLI's own registerGroup.ts (which deliberately DOES update
 * name/departure_date on conflict, an explicit human action), this NEVER
 * touches an existing row's name or departure_date -- telegram_chat_id is
 * the sole identity; a later Telegram title edit must never silently
 * overwrite an already-registered group's departure date.
 */
export async function createGroup(name: string, departureDate: string, telegramChatId: number): Promise<Group | null> {
  const { rows } = await pool.query<GroupRow>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_chat_id) DO NOTHING
     RETURNING id, name, departure_date, telegram_chat_id, google_sheet_id, google_sheet_gid, created_at, updated_at`,
    [name, departureDate, telegramChatId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findGroupById(id: string): Promise<Group | null> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, google_sheet_gid, created_at, updated_at
     FROM groups WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Atomically claims the right to be "the one who created this group's
 * spreadsheet": only succeeds (returns the row) if google_sheet_id was
 * still NULL at update time. If two callers race to provision a sheet for
 * the same group concurrently, only one UPDATE actually matches this WHERE
 * clause — the other gets null back and should discard its own
 * freshly-created spreadsheet and re-read the winner's id instead (see
 * ensureGroupSheet.ts). Never overwrites an already-set google_sheet_id.
 */
export async function setGroupGoogleSheetId(groupId: string, googleSheetId: string): Promise<Group | null> {
  const { rows } = await pool.query<GroupRow>(
    `UPDATE groups
     SET google_sheet_id = $2
     WHERE id = $1 AND google_sheet_id IS NULL
     RETURNING id, name, departure_date, telegram_chat_id, google_sheet_id, google_sheet_gid, created_at, updated_at`,
    [groupId, googleSheetId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export interface GroupSheetTab {
  id: string;
  googleSheetId: string;
  googleSheetGid: number;
}

interface GroupSheetTabRow {
  id: string;
  google_sheet_id: string;
  google_sheet_gid: number;
}

/**
 * Records where a group's passport rows live under the target "one master
 * file, one tab per group" architecture: `google_sheet_id` holds the
 * shared master spreadsheet's own id (the SAME value for every group on
 * this architecture -- unlike the legacy per-group dedicated-file id that
 * same column stores for a group provisioned the old way), and
 * `google_sheet_gid` holds this group's tab's stable numeric gid -- the
 * only identifier that survives a human later renaming the tab (see
 * sheetLayout.ts's withSheetTitle doc comment; a tab's title must never be
 * persisted anywhere as an addressing key).
 *
 * Both columns are written in a single atomic UPDATE keyed by id -- never
 * a read-then-write -- so this can never touch any other group's row.
 * Unlike setGroupGoogleSheetId's one-time "claim" semantics (its WHERE
 * also requires google_sheet_id IS NULL, since the legacy flow must never
 * overwrite an already-provisioned dedicated file's id), this function has
 * no such guard: it is a plain, idempotent "set these two fields for this
 * group" write, safe to call again later if the group's tab is ever
 * re-provisioned or repointed at a different master/gid.
 *
 * Returns null if groupId does not match any row (the same not-found
 * convention as findGroupById/createGroup -- no row, no throw).
 *
 * Not yet called from any production code path -- ensureGroupSheet.ts and
 * every other caller are updated in a later stage.
 */
export async function setGroupSheetTab(groupId: string, spreadsheetId: string, sheetId: number): Promise<GroupSheetTab | null> {
  const { rows } = await pool.query<GroupSheetTabRow>(
    `UPDATE groups
     SET google_sheet_id = $2, google_sheet_gid = $3
     WHERE id = $1
     RETURNING id, google_sheet_id, google_sheet_gid`,
    [groupId, spreadsheetId, sheetId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, googleSheetId: row.google_sheet_id, googleSheetGid: row.google_sheet_gid };
}

export async function listGroups(): Promise<Group[]> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, google_sheet_gid, created_at, updated_at
     FROM groups ORDER BY departure_date, name`,
  );
  return rows.map(mapRow);
}
