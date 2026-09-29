import { pool } from '../pool.js';

export type PassportIdentityStatus = 'active' | 'archived_source_deleted' | 'merged';

export interface PassportIdentityRecord {
  id: string;
  passportNumberNormalized: string;
  dateOfBirth: string;
  mrzChecksumValid: boolean | null;
  status: PassportIdentityStatus;
  mergedIntoIdentityId: string | null;
  /** Set only on an identity created by splitLink.ts — the identity this one was split out of. Null for every normally auto-resolved identity. */
  splitOriginIdentityId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PassportIdentityRow {
  id: string;
  passport_number_normalized: string;
  date_of_birth: string;
  mrz_checksum_valid: boolean | null;
  status: PassportIdentityStatus;
  merged_into_identity_id: string | null;
  split_origin_identity_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PassportIdentityRow): PassportIdentityRecord {
  return {
    id: row.id,
    passportNumberNormalized: row.passport_number_normalized,
    dateOfBirth: row.date_of_birth,
    mrzChecksumValid: row.mrz_checksum_valid,
    status: row.status,
    mergedIntoIdentityId: row.merged_into_identity_id,
    splitOriginIdentityId: row.split_origin_identity_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `
  id, passport_number_normalized, date_of_birth, mrz_checksum_valid,
  status, merged_into_identity_id, split_origin_identity_id, created_at, updated_at
`;

/**
 * Looks up the global identity for a (normalized passport number, DOB)
 * pair. Callers MUST pass an already-normalized passport number (see
 * normalizePassportNumber.ts) — this function never normalizes its input.
 * Matches regardless of status (active/archived/merged), since a lookup by
 * key must find an existing identity even if it's currently archived
 * (reactivation) or merged (the caller is expected to follow
 * mergedIntoIdentityId itself — this function never follows it silently).
 *
 * Since migration 0021, more than one row can share a key after a split
 * (the original identity plus whatever was split out of it) — the
 * uniqueness guarantee only holds among non-split identities. When more
 * than one row matches, this deterministically picks the OLDEST
 * (created_at ASC) — an explicit, documented consequence of relaxing the
 * constraint for split, not an arbitrary choice: new incoming messages
 * default to rejoining the more-established identity rather than a
 * recently split-out one, since there is no OCR-derivable signal to
 * prefer the split-out identity instead.
 */
export async function findPassportIdentityByKey(
  passportNumberNormalized: string,
  dateOfBirth: string,
): Promise<PassportIdentityRecord | null> {
  const { rows } = await pool.query<PassportIdentityRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_identity
     WHERE passport_number_normalized = $1 AND date_of_birth = $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [passportNumberNormalized, dateOfBirth],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findPassportIdentityById(id: string): Promise<PassportIdentityRecord | null> {
  const { rows } = await pool.query<PassportIdentityRow>(`SELECT ${SELECT_COLUMNS} FROM passport_identity WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Creates the one-and-only NORMALLY-RESOLVED identity row for a (passport
 * number, DOB) pair. Returns null if one already exists —
 * idx_passport_identity_key_unique (a partial unique index scoped to
 * split_origin_identity_id IS NULL, since migration 0021) is the
 * idempotency guarantee, same idiom as every other table in this schema.
 * Callers that need "find or create" (the OCR completion integration)
 * call findPassportIdentityByKey first, and only fall back to this on a
 * miss, re-reading on a null return here to pick up a concurrently-created
 * row (see ensureGroupSheet.ts for the same race pattern applied to
 * groups.google_sheet_id).
 *
 * splitOriginIdentityId is set ONLY by splitLink.ts, for the one
 * deliberate exception to this table's uniqueness: an identity explicitly
 * split out of another, permitted to share its origin's exact key. Every
 * other caller MUST leave it null — passing it here is not itself a
 * safeguard against misuse, splitLink.ts is the only sanctioned caller.
 */
export async function createPassportIdentity(
  passportNumberNormalized: string,
  dateOfBirth: string,
  mrzChecksumValid: boolean | null = null,
  splitOriginIdentityId: string | null = null,
): Promise<PassportIdentityRecord | null> {
  const { rows } = await pool.query<PassportIdentityRow>(
    `INSERT INTO passport_identity (passport_number_normalized, date_of_birth, mrz_checksum_valid, split_origin_identity_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (passport_number_normalized, date_of_birth) WHERE split_origin_identity_id IS NULL DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [passportNumberNormalized, dateOfBirth, mrzChecksumValid, splitOriginIdentityId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * State-transitions an identity (active <-> archived_source_deleted, or
 * -> merged with mergedIntoIdentityId set). Identity rows are never
 * physically deleted — this is the only mutation path for status.
 */
export async function setPassportIdentityStatus(
  id: string,
  status: PassportIdentityStatus,
  mergedIntoIdentityId: string | null = null,
): Promise<PassportIdentityRecord | null> {
  const { rows } = await pool.query<PassportIdentityRow>(
    `UPDATE passport_identity
     SET status = $2, merged_into_identity_id = $3
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, status, mergedIntoIdentityId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
