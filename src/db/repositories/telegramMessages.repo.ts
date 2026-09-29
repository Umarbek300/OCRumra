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
  /** The message's own Telegram caption, verbatim -- never passport data, never touched by OCR. Null when sent with no caption (possibly backfilled from a media-group sibling -- see ingestPhotoMessage.ts). */
  captionText: string | null;
  /** Telegram's album id when this message was sent as part of a media group. Null for a standalone message. */
  mediaGroupId: string | null;
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
  caption_text: string | null;
  media_group_id: string | null;
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
    captionText: row.caption_text,
    mediaGroupId: row.media_group_id,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `
  id, telegram_chat_id, telegram_message_id, telegram_sender_user_id,
  telegram_sender_display_name, message_timestamp, telegram_photo_file_id,
  source, group_id, agent_id, caption_text, media_group_id, created_at
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
  /** The message's own Telegram caption, verbatim. Null when sent with no caption. */
  captionText: string | null;
  /** Telegram's album id when this message was sent as part of a media group. Null for a standalone message. */
  mediaGroupId: string | null;
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
       source, group_id, agent_id, caption_text, media_group_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
      input.captionText,
      input.mediaGroupId,
    ],
  );
  const row = rows[0];
  return row ? { outcome: 'inserted', message: mapRow(row) } : { outcome: 'duplicate' };
}

/**
 * Telegram attaches a caption to only ONE message of a media group (album)
 * -- every sibling photo/document sent in the same album arrives with
 * caption = NULL, even though the operator wrote one caption for the whole
 * album. Looks for any already-recorded sibling in the same chat + album
 * that does have a caption, so a message missing its own caption can
 * borrow the album's. Returns null if no sibling with a caption exists yet
 * (e.g. it hasn't arrived/been processed yet, or there simply isn't one) --
 * never guesses, never fabricates a caption.
 */
export async function findCaptionForMediaGroup(telegramChatId: number, mediaGroupId: string): Promise<string | null> {
  const { rows } = await pool.query<{ caption_text: string | null }>(
    `SELECT caption_text FROM telegram_messages
     WHERE telegram_chat_id = $1 AND media_group_id = $2 AND caption_text IS NOT NULL
     ORDER BY created_at
     LIMIT 1`,
    [telegramChatId, mediaGroupId],
  );
  return rows[0]?.caption_text ?? null;
}

/**
 * The reverse direction of findCaptionForMediaGroup: when a message WITH a
 * caption arrives, propagates it to any sibling in the same chat + album
 * that was recorded earlier without one -- covering the case where the
 * caption-carrying message in the album isn't the first to arrive. Only
 * ever fills a NULL caption_text; never overwrites a sibling's own
 * already-known caption. Returns the number of sibling rows updated.
 */
export async function backfillCaptionForMediaGroup(
  telegramChatId: number,
  mediaGroupId: string,
  captionText: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE telegram_messages
     SET caption_text = $3
     WHERE telegram_chat_id = $1 AND media_group_id = $2 AND caption_text IS NULL`,
    [telegramChatId, mediaGroupId, captionText],
  );
  return rowCount ?? 0;
}

export async function findTelegramMessageById(id: string): Promise<TelegramMessageRecord | null> {
  const { rows } = await pool.query<TelegramMessageRow>(
    `SELECT ${SELECT_COLUMNS} FROM telegram_messages WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Unlinked messages for ONE chat -- what ensureGroupRegistered.ts's backfill sweep scans, scoped to the chat it just resolved a group for. */
export async function findUnlinkedMessagesByTelegramChatId(telegramChatId: number): Promise<TelegramMessageRecord[]> {
  const { rows } = await pool.query<TelegramMessageRow>(
    `SELECT ${SELECT_COLUMNS} FROM telegram_messages WHERE telegram_chat_id = $1 AND group_id IS NULL`,
    [telegramChatId],
  );
  return rows.map(mapRow);
}

/**
 * Backfill-only: patches a previously-unlinked message's group_id once its
 * group has been (auto-)registered. Guarded by `WHERE group_id IS NULL` --
 * a safe no-op (returns null) if something else already linked this exact
 * message between the caller's own read and this UPDATE, so a concurrent
 * or repeated backfill sweep can never double-link or clobber a link.
 */
export async function linkTelegramMessageToGroup(id: string, groupId: string): Promise<TelegramMessageRecord | null> {
  const { rows } = await pool.query<TelegramMessageRow>(
    `UPDATE telegram_messages SET group_id = $2 WHERE id = $1 AND group_id IS NULL RETURNING ${SELECT_COLUMNS}`,
    [id, groupId],
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
