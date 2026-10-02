import { pool } from '../pool.js';
import type { OcrConfidenceLevel } from './passportOcrResult.repo.js';

export type PassportLinkRole = 'canonical' | 'duplicate';
export type PassportLinkStatus = 'active' | 'cancelled' | 'removed' | 'moved';
export type PassportMatchConfidenceTier = 'high' | 'review' | 'new_identity';
export type PassportLinkResolvedBy = 'auto' | 'operator';

export interface PassportMessageLinkRecord {
  id: string;
  passportIdentityId: string;
  telegramMessageId: string;
  groupId: string;
  agentId: string | null;
  role: PassportLinkRole;
  linkStatus: PassportLinkStatus;
  matchConfidenceTier: PassportMatchConfidenceTier;
  resolvedBy: PassportLinkResolvedBy;
  createdAt: string;
}

interface PassportMessageLinkRow {
  id: string;
  passport_identity_id: string;
  telegram_message_id: string;
  group_id: string;
  agent_id: string | null;
  role: PassportLinkRole;
  link_status: PassportLinkStatus;
  match_confidence_tier: PassportMatchConfidenceTier;
  resolved_by: PassportLinkResolvedBy;
  created_at: string;
}

function mapRow(row: PassportMessageLinkRow): PassportMessageLinkRecord {
  return {
    id: row.id,
    passportIdentityId: row.passport_identity_id,
    telegramMessageId: row.telegram_message_id,
    groupId: row.group_id,
    agentId: row.agent_id,
    role: row.role,
    linkStatus: row.link_status,
    matchConfidenceTier: row.match_confidence_tier,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `
  id, passport_identity_id, telegram_message_id, group_id, agent_id,
  role, link_status, match_confidence_tier, resolved_by, created_at
`;

export interface CreatePassportMessageLinkInput {
  passportIdentityId: string;
  telegramMessageId: string;
  groupId: string;
  agentId: string | null;
  role: PassportLinkRole;
  matchConfidenceTier: PassportMatchConfidenceTier;
  resolvedBy?: PassportLinkResolvedBy;
}

/**
 * Creates the one-and-only link for a telegram_message. Returns null if
 * one already exists — UNIQUE(telegram_message_id), same idempotency
 * idiom as every other table here. When role='canonical', the partial
 * unique index idx_passport_message_links_one_active_canonical also
 * guards against ever creating a second active canonical for the same
 * (identity, group) — a violation there surfaces as a real constraint
 * error, never a silent duplicate.
 */
export async function createPassportMessageLink(
  input: CreatePassportMessageLinkInput,
): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `INSERT INTO passport_message_links (
       passport_identity_id, telegram_message_id, group_id, agent_id,
       role, match_confidence_tier, resolved_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (telegram_message_id) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.passportIdentityId,
      input.telegramMessageId,
      input.groupId,
      input.agentId,
      input.role,
      input.matchConfidenceTier,
      input.resolvedBy ?? 'auto',
    ],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findPassportMessageLinkById(id: string): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(`SELECT ${SELECT_COLUMNS} FROM passport_message_links WHERE id = $1`, [
    id,
  ]);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findPassportMessageLinkByTelegramMessageId(
  telegramMessageId: string,
): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_message_links WHERE telegram_message_id = $1`,
    [telegramMessageId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** The active canonical link for a (identity, group) pair, or null if none exists yet (or the previous one left the active set). */
export async function findActiveCanonicalLink(
  passportIdentityId: string,
  groupId: string,
): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_message_links
     WHERE passport_identity_id = $1 AND group_id = $2 AND role = 'canonical' AND link_status = 'active'`,
    [passportIdentityId, groupId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Every applicant CURRENTLY in a group -- i.e. every active canonical link
 * for groupId, one per distinct passport identity. This is the enumeration
 * primitive visa automation needs (see visaAssignCommand.ts) to discover
 * "who is in this group right now" without the caller having to already
 * know each passport_identity_id individually, the way every other lookup
 * in this file requires. A duplicate-role or non-active link is excluded
 * for the identical reason computeGroupGenderStats excludes them: it has no
 * physical row of its own in the group's Sheet, so there is nothing for
 * visa automation to read or assign for it either.
 */
export async function findActiveCanonicalLinksForGroup(groupId: string): Promise<PassportMessageLinkRecord[]> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_message_links
     WHERE group_id = $1 AND role = 'canonical' AND link_status = 'active'
     ORDER BY created_at ASC`,
    [groupId],
  );
  return rows.map(mapRow);
}

export interface CanonicalReassignmentCandidate {
  linkId: string;
  telegramMessageId: string;
  passportNumberConfidence: OcrConfidenceLevel;
  dobConfidence: OcrConfidenceLevel;
  messageTimestamp: string;
}

/**
 * Active duplicate links for a (identity, group) pair, joined against
 * their own OCR result's field-level confidence and the source message's
 * timestamp — exactly the shape selectNewCanonical.ts needs to pick a
 * replacement canonical. A link whose telegram_message has no OCR result
 * (should not normally happen, since a link is only ever created after
 * OCR completes) is excluded rather than crashing the reassignment.
 */
export async function findActiveDuplicateCandidates(
  passportIdentityId: string,
  groupId: string,
): Promise<CanonicalReassignmentCandidate[]> {
  const { rows } = await pool.query<{
    link_id: string;
    telegram_message_id: string;
    passport_number_confidence: OcrConfidenceLevel;
    date_of_birth_confidence: OcrConfidenceLevel;
    message_timestamp: string;
  }>(
    `SELECT
       pml.id AS link_id,
       pml.telegram_message_id,
       por.passport_number_confidence,
       por.date_of_birth_confidence,
       tm.message_timestamp
     FROM passport_message_links pml
     JOIN passport_ocr_results por ON por.telegram_message_id = pml.telegram_message_id
     JOIN telegram_messages tm ON tm.id = pml.telegram_message_id
     WHERE pml.passport_identity_id = $1
       AND pml.group_id = $2
       AND pml.role = 'duplicate'
       AND pml.link_status = 'active'
       AND por.passport_number_confidence IS NOT NULL
       AND por.date_of_birth_confidence IS NOT NULL`,
    [passportIdentityId, groupId],
  );
  return rows.map((row) => ({
    linkId: row.link_id,
    telegramMessageId: row.telegram_message_id,
    passportNumberConfidence: row.passport_number_confidence,
    dobConfidence: row.date_of_birth_confidence,
    messageTimestamp: row.message_timestamp,
  }));
}

/** Flips a link's role (canonical <-> duplicate). Used by canonical reassignment — see applyIdentityStateChange.ts for the transactional wrapper that changes two links together. */
export async function setPassportMessageLinkRole(id: string, role: PassportLinkRole): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `UPDATE passport_message_links SET role = $2 WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    [id, role],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Sets a link's operator-driven status (active/cancelled/removed/moved). Independent of role — see the table's own migration comment. */
export async function setPassportMessageLinkStatus(
  id: string,
  linkStatus: PassportLinkStatus,
): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `UPDATE passport_message_links SET link_status = $2 WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    [id, linkStatus],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** All links (any role/status) for an identity — used by identity-merge to enumerate what needs absorbing into the survivor. */
export async function findAllLinksForIdentity(passportIdentityId: string): Promise<PassportMessageLinkRecord[]> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `SELECT ${SELECT_COLUMNS} FROM passport_message_links WHERE passport_identity_id = $1`,
    [passportIdentityId],
  );
  return rows.map(mapRow);
}

export interface LinkEvidence {
  linkId: string;
  role: PassportLinkRole;
  linkStatus: PassportLinkStatus;
  groupId: string;
  telegramMessageId: string;
  passportNumberConfidence: OcrConfidenceLevel;
  dobConfidence: OcrConfidenceLevel;
}

/**
 * Every link for an identity (any role/status, unlike
 * findActiveDuplicateCandidates), joined against its own OCR confidence —
 * the evidence set identity-merge (design spec Decision N-4) scores to
 * pick a survivor. A link whose message has no OCR result is excluded
 * (should not normally happen, since a link is only ever created after
 * OCR completes).
 */
export async function findAllLinksWithConfidenceForIdentity(passportIdentityId: string): Promise<LinkEvidence[]> {
  const { rows } = await pool.query<{
    link_id: string;
    role: PassportLinkRole;
    link_status: PassportLinkStatus;
    group_id: string;
    telegram_message_id: string;
    passport_number_confidence: OcrConfidenceLevel;
    date_of_birth_confidence: OcrConfidenceLevel;
  }>(
    `SELECT
       pml.id AS link_id, pml.role, pml.link_status, pml.group_id, pml.telegram_message_id,
       por.passport_number_confidence, por.date_of_birth_confidence
     FROM passport_message_links pml
     JOIN passport_ocr_results por ON por.telegram_message_id = pml.telegram_message_id
     WHERE pml.passport_identity_id = $1
       AND por.passport_number_confidence IS NOT NULL
       AND por.date_of_birth_confidence IS NOT NULL`,
    [passportIdentityId],
  );
  return rows.map((row) => ({
    linkId: row.link_id,
    role: row.role,
    linkStatus: row.link_status,
    groupId: row.group_id,
    telegramMessageId: row.telegram_message_id,
    passportNumberConfidence: row.passport_number_confidence,
    dobConfidence: row.date_of_birth_confidence,
  }));
}

/** Re-points a link at a different identity — used only by the identity-merge correction path (see applyIdentityStateChange.ts). Never used by ordinary auto-resolution. */
export async function reassignLinkToIdentity(id: string, passportIdentityId: string): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `UPDATE passport_message_links SET passport_identity_id = $2 WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    [id, passportIdentityId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Re-points a link at a different group — the MOVE_TO_GROUP mechanism
 * (design spec §G). A message can only ever hold ONE link row at all
 * (UNIQUE(telegram_message_id)), so "moving" a passport to another group
 * is implemented as relocating its existing canonical link, never as
 * creating a second row for the same message. role/agent_id are left
 * untouched — the sender's own agent attribution never changes just
 * because the group it's counted against does.
 */
export async function reassignLinkToGroup(id: string, groupId: string): Promise<PassportMessageLinkRecord | null> {
  const { rows } = await pool.query<PassportMessageLinkRow>(
    `UPDATE passport_message_links SET group_id = $2 WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    [id, groupId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
