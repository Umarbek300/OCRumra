import { pool } from '../pool.js';

export type TelegramMessageSource = 'photo' | 'document';

export interface TelegramMessageRecord {
  id: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramSenderUserId: string;
  telegramSenderDisplayName: string | null;
  messageTimestamp: string;
  telegramPhotoFileId: string;
  source: TelegramMessageSource;
  groupId: string | null;
  agentId: string | null;
  createdAt: string;
}

interface TelegramMessageRow {
  id: string;
  telegram_chat_id: string;
  telegram_message_id: string;
  telegram_sender_user_id: string;
  telegram_sender_display_name: string | null;
  message_timestamp: string;
  telegram_photo_file_id: string;
  source: TelegramMessageSource;
  group_id: string | null;
  agent_id: string | null;
  created_at: string;
}

function mapRow(row: TelegramMessageRow): TelegramMessageRecord {
  return {
    id: row.id,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
    telegramSenderUserId: row.telegram_sender_user_id,
    telegramSenderDisplayName: row.telegram_sender_display_name,
    messageTimestamp: row.message_timestamp,
    telegramPhotoFileId: row.telegram_photo_file_id,
    source: row.source,
    groupId: row.group_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `
  id, telegram_chat_id, telegram_message_id, telegram_sender_user_id,
  telegram_sender_display_name, message_timestamp, telegram_photo_file_id,
  source, group_id, agent_id, created_at
`;

export interface RecordPhotoMessageInput {
  telegramChatId: number;
  telegramMessageId: number;
  telegramSenderUserId: number;
  telegramSenderDisplayName: string | null;
  messageTimestamp: Date;
  telegramPhotoFileId: string;
  source: TelegramMessageSource;
  groupId: string | null;
  agentId: string | null;
}

export type RecordPhotoMessageResult =
  | { outcome: 'inserted'; message: TelegramMessageRecord }
  | { outcome: 'duplicate' };

/**
 * Inserts a Telegram photo-message event. (chat_id, message_id) is unique,
 * so an update Telegram redelivers is a no-op rather than a duplicate row.
 */
export async function recordPhotoMessage(
  input: RecordPhotoMessageInput,
): Promise<RecordPhotoMessageResult> {
  const { rows } = await pool.query<TelegramMessageRow>(
    `INSERT INTO telegram_messages (
       telegram_chat_id, telegram_message_id, telegram_sender_user_id,
       telegram_sender_display_name, message_timestamp, telegram_photo_file_id,
       source, group_id, agent_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (telegram_chat_id, telegram_message_id) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.telegramChatId,
      input.telegramMessageId,
      input.telegramSenderUserId,
      input.telegramSenderDisplayName,
      input.messageTimestamp,
      input.telegramPhotoFileId,
      input.source,
      input.groupId,
      input.agentId,
    ],
  );
  const row = rows[0];
  return row ? { outcome: 'inserted', message: mapRow(row) } : { outcome: 'duplicate' };
}

export async function findTelegramMessageById(id: string): Promise<TelegramMessageRecord | null> {
  const { rows } = await pool.query<TelegramMessageRow>(
    `SELECT ${SELECT_COLUMNS} FROM telegram_messages WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function listUnlinkedMessages(): Promise<TelegramMessageRecord[]> {
  const { rows } = await pool.query<TelegramMessageRow>(
    `SELECT ${SELECT_COLUMNS} FROM telegram_messages
     WHERE group_id IS NULL OR agent_id IS NULL
     ORDER BY message_timestamp DESC`,
  );
  return rows.map(mapRow);
}

export async function listLinkedMessages(): Promise<TelegramMessageRecord[]> {
  const { rows } = await pool.query<TelegramMessageRow>(
    `SELECT ${SELECT_COLUMNS} FROM telegram_messages
     WHERE group_id IS NOT NULL AND agent_id IS NOT NULL
     ORDER BY message_timestamp DESC`,
  );
  return rows.map(mapRow);
}
