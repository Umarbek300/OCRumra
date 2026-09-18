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

export async function listGroups(): Promise<Group[]> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, name, departure_date, telegram_chat_id, google_sheet_id, created_at, updated_at
     FROM groups ORDER BY departure_date, name`,
  );
  return rows.map(mapRow);
}
