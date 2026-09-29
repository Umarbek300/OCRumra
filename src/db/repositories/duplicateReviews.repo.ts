import { pool } from '../pool.js';

export type DuplicateReviewReason = 'agent_mismatch' | 'low_confidence_field' | 'conflicting_fields';
export type DuplicateReviewStatus = 'pending' | 'confirmed_duplicate' | 'confirmed_distinct';

export interface DuplicateReviewRecord {
  id: string;
  passportIdentityId: string;
  candidateTelegramMessageId: string;
  matchedAgainstTelegramMessageId: string | null;
  reviewReason: DuplicateReviewReason;
  status: DuplicateReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

interface DuplicateReviewRow {
  id: string;
  passport_identity_id: string;
  candidate_telegram_message_id: string;
  matched_against_telegram_message_id: string | null;
  review_reason: DuplicateReviewReason;
  status: DuplicateReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

function mapRow(row: DuplicateReviewRow): DuplicateReviewRecord {
  return {
    id: row.id,
    passportIdentityId: row.passport_identity_id,
    candidateTelegramMessageId: row.candidate_telegram_message_id,
    matchedAgainstTelegramMessageId: row.matched_against_telegram_message_id,
    reviewReason: row.review_reason,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `
  id, passport_identity_id, candidate_telegram_message_id, matched_against_telegram_message_id,
  review_reason, status, reviewed_by, reviewed_at, created_at
`;

export interface CreateDuplicateReviewInput {
  passportIdentityId: string;
  candidateTelegramMessageId: string;
  matchedAgainstTelegramMessageId: string | null;
  reviewReason: DuplicateReviewReason;
}

/**
 * Flags a candidate message for review. Returns null if this exact
 * candidate already has an open (pending) review —
 * idx_duplicate_reviews_one_pending_per_candidate guards against a
 * redundant second review row for the same message.
 */
export async function createDuplicateReview(input: CreateDuplicateReviewInput): Promise<DuplicateReviewRecord | null> {
  const { rows } = await pool.query<DuplicateReviewRow>(
    `INSERT INTO duplicate_reviews (
       passport_identity_id, candidate_telegram_message_id, matched_against_telegram_message_id, review_reason
     ) VALUES ($1,$2,$3,$4)
     ON CONFLICT (candidate_telegram_message_id) WHERE status = 'pending' DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [input.passportIdentityId, input.candidateTelegramMessageId, input.matchedAgainstTelegramMessageId, input.reviewReason],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findDuplicateReviewById(id: string): Promise<DuplicateReviewRecord | null> {
  const { rows } = await pool.query<DuplicateReviewRow>(`SELECT ${SELECT_COLUMNS} FROM duplicate_reviews WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Most recent review (any status) for a candidate message — used to detect an already-pending review on reprocessing (idempotency guard, see resolveAndLinkIdentity.ts). */
export async function findDuplicateReviewByCandidateMessageId(candidateTelegramMessageId: string): Promise<DuplicateReviewRecord | null> {
  const { rows } = await pool.query<DuplicateReviewRow>(
    `SELECT ${SELECT_COLUMNS} FROM duplicate_reviews WHERE candidate_telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [candidateTelegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function listPendingDuplicateReviews(): Promise<DuplicateReviewRecord[]> {
  const { rows } = await pool.query<DuplicateReviewRow>(
    `SELECT ${SELECT_COLUMNS} FROM duplicate_reviews WHERE status = 'pending' ORDER BY created_at`,
  );
  return rows.map(mapRow);
}

/**
 * Atomically resolves a pending review: pending -> confirmed_duplicate |
 * confirmed_distinct. Returns null if the row wasn't pending (already
 * resolved) — the idempotency guard: resolving an already-resolved review
 * a second time is a safe no-op at the call site (see
 * resolveDuplicateReview.ts), never a duplicate state change.
 */
export async function resolveDuplicateReview(
  id: string,
  status: Extract<DuplicateReviewStatus, 'confirmed_duplicate' | 'confirmed_distinct'>,
  reviewedBy: string,
): Promise<DuplicateReviewRecord | null> {
  const { rows } = await pool.query<DuplicateReviewRow>(
    `UPDATE duplicate_reviews
     SET status = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING ${SELECT_COLUMNS}`,
    [id, status, reviewedBy],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
