import { createPassportIdentity, findPassportIdentityById } from '../db/repositories/passportIdentity.repo.js';
import {
  findActiveDuplicateCandidates,
  findPassportMessageLinkById,
  type CanonicalReassignmentCandidate,
} from '../db/repositories/passportMessageLinks.repo.js';
import { findPassportOcrResultByTelegramMessageId } from '../db/repositories/passportOcrResult.repo.js';
import { enqueueSheetSync, requeueSheetSyncForResync } from '../db/repositories/sheetSyncQueue.repo.js';
import { applySplitTransaction } from './applyIdentityStateChange.js';
import { normalizePassportNumber } from './normalizePassportNumber.js';
import { selectNewCanonical } from './selectNewCanonical.js';

export interface SplitLinkDependencies {
  findLink: typeof findPassportMessageLinkById;
  findIdentity: typeof findPassportIdentityById;
  findOcrResult: typeof findPassportOcrResultByTelegramMessageId;
  findActiveDuplicateCandidates: typeof findActiveDuplicateCandidates;
  createIdentity: typeof createPassportIdentity;
  applySplit: typeof applySplitTransaction;
  requeueSheetSync: typeof requeueSheetSyncForResync;
  enqueueSheetSync: typeof enqueueSheetSync;
}

const defaultDependencies: SplitLinkDependencies = {
  findLink: findPassportMessageLinkById,
  findIdentity: findPassportIdentityById,
  findOcrResult: findPassportOcrResultByTelegramMessageId,
  findActiveDuplicateCandidates,
  createIdentity: createPassportIdentity,
  applySplit: applySplitTransaction,
  requeueSheetSync: requeueSheetSyncForResync,
  enqueueSheetSync,
};

export type SplitLinkResult =
  | { outcome: 'already_split'; newIdentityId: string }
  | { outcome: 'split'; newIdentityId: string; originalIdentityId: string };

/**
 * Splits an incorrectly auto-merged (or incorrectly operator-confirmed)
 * link out of its current passport_identity into a brand-new one — the
 * reverse of mergeIdentities.ts, per your original business rule ("both
 * directions of identity correction MUST be supported").
 *
 * Schema note: this is only possible because migration 0021 relaxed
 * passport_identity's uniqueness — every automatic resolution path finds
 * an identity via an EXACT (passport_number_normalized, date_of_birth)
 * match, so a split-out link's new identity necessarily shares its
 * origin's exact key. See that migration's own doc comment and
 * passportIdentity.repo.ts's createPassportIdentity for the mechanism
 * (a partial unique index scoped to split_origin_identity_id IS NULL).
 *
 * The split link's role is ALWAYS set to 'canonical' under the new
 * identity (a freshly split-out identity has exactly one link, so it is
 * trivially that identity's own canonical for its group) — regardless of
 * whether it was 'canonical' or 'duplicate' under the original identity.
 * If it WAS canonical there, the remaining duplicates for
 * (originalIdentityId, groupId) are re-scored (design spec §F, same
 * candidateScore/selectNewCanonical used everywhere else) to pick a
 * replacement; with none remaining, that group's Sheet row is deleted.
 *
 * Sheet synchronization (P1): the ORIGINAL identity's group cleanup
 * (reassign/delete) is now a durable sheet_reconciliation_jobs row,
 * enqueued by applySplitTransaction IN THE SAME transaction as the domain
 * change — this function makes no direct Sheets call for that side at all
 * any more; the reconciliation worker resolves it crash-safely afterward.
 * The NEW identity's own fresh canonical, by contrast, is an ordinary
 * append with no existing row to find — exactly what the normal
 * sheet_sync_queue pipeline already does correctly, so THAT side is
 * routed through requeueSheetSyncForResync (or enqueueSheetSync as a
 * fallback if no job exists yet), never a direct Sheets call, per your
 * explicit instruction to use the normal pipeline where it genuinely applies.
 *
 * Idempotent: if this link's CURRENT identity is itself already a
 * split-out identity (splitOriginIdentityId set), the link has already
 * been split — repeating the command is a safe no-op, returning the
 * existing split-out identity's id rather than creating another.
 *
 * Writes exactly one identity_split event (on the original identity).
 */
export async function splitLink(
  linkId: string,
  operatorId: string,
  deps: SplitLinkDependencies = defaultDependencies,
): Promise<SplitLinkResult> {
  const link = await deps.findLink(linkId);
  if (!link) {
    throw new Error(`splitLink: link ${linkId} not found`);
  }

  const currentIdentity = await deps.findIdentity(link.passportIdentityId);
  if (!currentIdentity) {
    throw new Error(`splitLink: identity ${link.passportIdentityId} not found`);
  }
  if (currentIdentity.splitOriginIdentityId) {
    return { outcome: 'already_split', newIdentityId: currentIdentity.id };
  }

  const ocrResult = await deps.findOcrResult(link.telegramMessageId);
  if (!ocrResult || !ocrResult.passportNumber.value || !ocrResult.dateOfBirth.value) {
    throw new Error(`splitLink: no usable OCR passport number/DOB for message ${link.telegramMessageId} to key the new identity`);
  }
  const normalizedPassportNumber = normalizePassportNumber(ocrResult.passportNumber.value);

  const newIdentity = await deps.createIdentity(normalizedPassportNumber, ocrResult.dateOfBirth.value, null, currentIdentity.id);
  if (!newIdentity) {
    throw new Error(`splitLink: failed to create split-out identity for link ${linkId} (unexpected conflict)`);
  }

  const wasActiveCanonical = link.role === 'canonical' && link.linkStatus === 'active';
  let replacement: CanonicalReassignmentCandidate | null = null;
  if (wasActiveCanonical) {
    const candidates = await deps.findActiveDuplicateCandidates(currentIdentity.id, link.groupId);
    replacement = selectNewCanonical(candidates.filter((candidate) => candidate.linkId !== linkId));
  }

  await deps.applySplit({
    linkId,
    newIdentityId: newIdentity.id,
    originalIdentityId: currentIdentity.id,
    groupId: link.groupId,
    replacementLinkId: replacement?.linkId ?? null,
    needsOriginReconciliation: wasActiveCanonical,
    relatedTelegramMessageId: link.telegramMessageId,
    operatorId,
  });

  // New identity's own canonical: route through the normal sheet_sync_queue
  // pipeline (an ordinary append — no existing row to repoint), not a
  // direct Sheets call.
  const requeued = await deps.requeueSheetSync(link.telegramMessageId);
  if (!requeued) {
    await deps.enqueueSheetSync(link.telegramMessageId);
  }

  return { outcome: 'split', newIdentityId: newIdentity.id, originalIdentityId: currentIdentity.id };
}
