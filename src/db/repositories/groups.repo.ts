import { pool } from '../pool.js';

export interface Group {
  id: string;
  name: string;
  departureDate: string;
  telegramChatId: string | null;
  googleSheetId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow {
  id: string;
  name: string;
  departure_date: string;
  telegram_chat_id: string | null;
  google_sheet_id: string | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findGroupByTelegramChatId(telegramChatId: number): Promise<Group | null> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, created_at, updated_at
     FROM groups WHERE telegram_chat_id = $1`,
    [telegramChatId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findGroupById(id: string): Promise<Group | null> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, created_at, updated_at
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
     RETURNING id, name, departure_date, telegram_chat_id, google_sheet_id, created_at, updated_at`,
    [groupId, googleSheetId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function listGroups(): Promise<Group[]> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, created_at, updated_at
     FROM groups ORDER BY departure_date, name`,
  );
  return rows.map(mapRow);
}
