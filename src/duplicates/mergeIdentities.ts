import { findPassportIdentityById } from '../db/repositories/passportIdentity.repo.js';
import { findAllLinksWithConfidenceForIdentity, type LinkEvidence } from '../db/repositories/passportMessageLinks.repo.js';
import { mergeIdentitiesTransaction, type MergeLinkPlan, type MergeStaleSheetRow } from './applyIdentityStateChange.js';
import { candidateScore } from './selectNewCanonical.js';

function bestEvidenceScore(links: readonly LinkEvidence[]): number {
  if (links.length === 0) {
    return -1;
  }
  return Math.max(...links.map((link) => candidateScore(link)));
}

export interface MergeIdentitiesDependencies {
  findIdentity: typeof findPassportIdentityById;
  findLinks: typeof findAllLinksWithConfidenceForIdentity;
  applyMerge: typeof mergeIdentitiesTransaction;
}

const defaultDependencies: MergeIdentitiesDependencies = {
  findIdentity: findPassportIdentityById,
  findLinks: findAllLinksWithConfidenceForIdentity,
  applyMerge: mergeIdentitiesTransaction,
};

export interface MergeIdentitiesResult {
  survivorId: string;
  loserId: string;
}

/**
 * Merges two independently-created passport_identity rows later confirmed
 * to be the same physical document — the "two identities incorrectly kept
 * apart, later confirmed to be one document" correction path (design spec
 * §I / your Decision N-4). The reverse direction (an incorrect AUTO_MERGE
 * that must be split back apart) is handled separately, by re-running
 * ordinary identity resolution for the wrongly-merged message once an
 * operator detaches it — this function only ever combines, never splits.
 *
 * Survivor selection (exactly per Decision N-4):
 *   1. Compare each identity's BEST available field-level evidence —
 *      min(passport_number_confidence, dob_confidence) across each of its
 *      links, the SAME scoring selectNewCanonical.ts already uses for
 *      canonical reassignment (never the separate overall_confidence
 *      field) — and take the strongest single link's score per identity.
 *   2. Higher score wins.
 *   3. A tie falls back to whichever identity has the earlier created_at.
 *
 * Never physically deletes either identity — the loser is state-
 * transitioned to 'merged' with merged_into_identity_id set; the survivor
 * absorbs all of the loser's links (across every group), preserving each
 * link's own group-specific operational data (agent_id, role where no
 * conflict exists) rather than discarding it. Writes exactly one
 * identity_merged event, recorded against the survivor.
 *
 * Canonical-slot conflicts — both identities already independently
 * canonical in the SAME group — are resolved with the identical
 * per-group scoring (the same candidateScore rules selectNewCanonical.ts
 * uses elsewhere); the weaker side is demoted to 'duplicate'.
 *
 * Sheet consistency for a conflict (P1): BOTH sides of a same-group
 * conflict necessarily already had their own synced canonical Sheet row
 * (only a role='canonical' && link_status='active' link is ever synced),
 * so after the merge there are two existing rows for what is now a single
 * (survivor identity, group) pair — one correct going forward, one stale.
 * mergeIdentitiesTransaction enqueues a durable sheet_reconciliation_jobs
 * row for each such conflict, IN THE SAME TRANSACTION as the domain change
 * — this function makes NO direct Sheets call at all any more. The
 * reconciliation worker later re-resolves the current truth and either
 * deletes the demoted side's row or reassigns it, crash-safely (see
 * sheet_reconciliation_jobs's own migration comment and
 * reconcileSheetRow.ts). A loser link that was never canonical (or was
 * canonical but already cancelled/removed/moved) never had a row to begin
 * with and needs no reconciliation. A loser link that becomes canonical
 * for the survivor WITHOUT a conflict keeps its own existing row exactly
 * as-is too — the row's content is entirely message-derived, so changing
 * which identity logically owns the link doesn't invalidate it.
 */
export async function mergeIdentities(
  identityAId: string,
  identityBId: string,
  operatorId: string,
  deps: MergeIdentitiesDependencies = defaultDependencies,
): Promise<MergeIdentitiesResult> {
  const [identityA, identityB] = await Promise.all([deps.findIdentity(identityAId), deps.findIdentity(identityBId)]);
  if (!identityA || !identityB) {
    throw new Error(`mergeIdentities: one or both identities not found (${identityAId}, ${identityBId})`);
  }

  const [linksA, linksB] = await Promise.all([deps.findLinks(identityAId), deps.findLinks(identityBId)]);
  const scoreA = bestEvidenceScore(linksA);
  const scoreB = bestEvidenceScore(linksB);

  let survivorId: string;
  let loserId: string;
  let survivorLinks: LinkEvidence[];
  let loserLinks: LinkEvidence[];

  if (scoreA > scoreB) {
    survivorId = identityAId;
    loserId = identityBId;
    survivorLinks = linksA;
    loserLinks = linksB;
  } else if (scoreB > scoreA) {
    survivorId = identityBId;
    loserId = identityAId;
    survivorLinks = linksB;
    loserLinks = linksA;
  } else if (new Date(identityA.createdAt).getTime() <= new Date(identityB.createdAt).getTime()) {
    survivorId = identityAId;
    loserId = identityBId;
    survivorLinks = linksA;
    loserLinks = linksB;
  } else {
    survivorId = identityBId;
    loserId = identityAId;
    survivorLinks = linksB;
    loserLinks = linksA;
  }

  const plans: MergeLinkPlan[] = [];
  const staleSheetRows: MergeStaleSheetRow[] = [];

  for (const loserLink of loserLinks) {
    if (loserLink.role !== 'canonical' || loserLink.linkStatus !== 'active') {
      plans.push({ linkId: loserLink.linkId, becomesCanonical: false, demoteSurvivorLinkId: null });
      continue;
    }

    const survivorConflict = survivorLinks.find(
      (link) => link.groupId === loserLink.groupId && link.role === 'canonical' && link.linkStatus === 'active',
    );
    if (!survivorConflict) {
      plans.push({ linkId: loserLink.linkId, becomesCanonical: true, demoteSurvivorLinkId: null });
      continue;
    }

    const loserWinsConflict = candidateScore(loserLink) > candidateScore(survivorConflict);
    plans.push({
      linkId: loserLink.linkId,
      becomesCanonical: loserWinsConflict,
      demoteSurvivorLinkId: loserWinsConflict ? survivorConflict.linkId : null,
    });
    staleSheetRows.push({
      groupId: loserLink.groupId,
      telegramMessageId: loserWinsConflict ? survivorConflict.telegramMessageId : loserLink.telegramMessageId,
    });
  }

  await deps.applyMerge({ survivorId, loserId, linkPlans: plans, staleSheetRows, operatorId });

  return { survivorId, loserId };
}
