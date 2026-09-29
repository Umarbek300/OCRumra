import { pool } from '../pool.js';

export type PassportIdentityEventType =
  | 'identity_created'
  | 'message_linked_canonical'
  | 'message_linked_duplicate'
  | 'canonical_reassigned'
  | 'review_flagged'
  | 'review_resolved'
  | 'identity_merged'
  | 'identity_split'
  | 'cancel_passport'
  | 'remove_from_group'
  | 'group_transferred'
  | 'sheet_row_deleted'
  | 'identity_reactivated';

export type PassportIdentityEventActor = 'system' | 'operator';

export interface PassportIdentityEventRecord {
  id: string;
  passportIdentityId: string;
  eventType: PassportIdentityEventType;
  groupId: string | null;
  relatedTelegramMessageId: string | null;
  actor: PassportIdentityEventActor;
  operatorId: string | null;
  detail: string | null;
  createdAt: string;
}

interface PassportIdentityEventRow {
  id: string;
  passport_identity_id: string;
  event_type: PassportIdentityEventType;
  group_id: string | null;
  related_telegram_message_id: string | null;
  actor: PassportIdentityEventActor;
  operator_id: string | null;
  detail: string | null;
  created_at: string;
}

function mapRow(row: PassportIdentityEventRow): PassportIdentityEventRecord {
  return {
    id: row.id,
    passportIdentityId: row.passport_identity_id,
    eventType: row.event_type,
    groupId: row.group_id,
    relatedTelegramMessageId: row.related_telegram_message_id,
    actor: row.actor,
    operatorId: row.operator_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `
  id, passport_identity_id, event_type, group_id, related_telegram_message_id,
  actor, operator_id, detail, created_at
`;

const MAX_DETAIL_LENGTH = 300;

export interface RecordPassportIdentityEventInput {
  passportIdentityId: string;
  eventType: PassportIdentityEventType;
  groupId?: string | null;
  relatedTelegramMessageId?: string | null;
  actor: PassportIdentityEventActor;
  operatorId?: string | null;
  detail?: string | null;
}

/**
 * Appends one immutable audit row. Never updated or deleted after insert —
 * this table is the full history trail for every state-changing action
 * this feature performs. detail is bounded the same way as
 * syncPassportRowToSheet.ts's sanitizeErrorMessage — a plain description
 * only, never OCR/passport field values.
 */
export async function recordPassportIdentityEvent(
  input: RecordPassportIdentityEventInput,
): Promise<PassportIdentityEventRecord> {
  const boundedDetail = input.detail ? input.detail.slice(0, MAX_DETAIL_LENGTH) : null;
  const { rows } = await pool.query<PassportIdentityEventRow>(
    `INSERT INTO passport_identity_events (
       passport_identity_id, event_type, group_id, related_telegram_message_id, actor, operator_id, detail
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.passportIdentityId,
      input.eventType,
      input.groupId ?? null,
      input.relatedTelegramMessageId ?? null,
      input.actor,
      input.operatorId ?? null,
      boundedDetail,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error('recordPassportIdentityEvent: insert unexpectedly returned no row');
  }
  return mapRow(row);
}

export async function listEventsForIdentity(passportIdentityId: string): Promise<PassportIdentityEventRecord[]> {
  const { rows } = await pool.query<PassportIdentityEventRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_identity_events WHERE passport_identity_id = $1 ORDER BY created_at`,
    [passportIdentityId],
  );
  return rows.map(mapRow);
}
