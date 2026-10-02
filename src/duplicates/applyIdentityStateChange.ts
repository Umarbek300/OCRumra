import { pool } from '../db/pool.js';
import type { PassportLinkStatus } from '../db/repositories/passportMessageLinks.repo.js';
import type { PassportIdentityEventType } from '../db/repositories/passportIdentityEvents.repo.js';
import { insertReconciliationJobWithClient } from '../db/repositories/sheetReconciliation.repo.js';
import { updateActiveAssignmentsStatusWithClient } from '../db/repositories/visaBatches.repo.js';

export interface RetireAndPromoteInput {
  oldCanonicalLinkId: string;
  /** The retiring link's OWN telegram_message_id — the anchor a durable sheet_reconciliation_jobs row needs to later locate its Sheet row (see that table's own doc comment). */
  oldCanonicalTelegramMessageId: string;
  oldCanonicalRetiredStatus: Extract<PassportLinkStatus, 'cancelled' | 'removed' | 'moved'>;
  /** null when no replacement exists at COMMIT time — irrelevant to the Sheet side now: the reconciliation worker re-resolves this fresh regardless (see reconcileSheetRow.ts). */
  replacementLinkId: string | null;
  passportIdentityId: string;
  groupId: string;
  retireEventType: PassportIdentityEventType;
  reassignEventType: Extract<PassportIdentityEventType, 'canonical_reassigned'> | null;
  relatedTelegramMessageId: string | null;
  operatorId: string;
  detail: string | null;
}

/**
 * The one genuinely new transactional primitive this feature introduces
 * (design spec §H step 2 / §I) — every other table in this schema only
 * ever needs a single-statement atomic UPDATE, but retiring a canonical
 * link and promoting its replacement are two rows (plus an audit event)
 * that must never apply partially: a crash between them would otherwise
 * leave BOTH links inactive, or two links simultaneously marked canonical.
 *
 * Also enqueues exactly one sheet_reconciliation_jobs row, IN THIS SAME
 * transaction — the caller no longer makes any direct Sheets call at all.
 * This is the P1 crash-safety fix: a crash right after this COMMIT can
 * never lose the fact that the Sheet still owes a delete/reassign for this
 * (identity, group), because the domain change and that durable IOU are
 * the same atomic write. See sheet_reconciliation_jobs's own migration
 * comment and reconcileSheetRow.ts for how the worker later resolves it.
 *
 * Runs directly against `pool` (not dependency-injected) since a
 * transaction is inherently tied to one real connection — unlike every
 * other function in this codebase's repositories, which are individually
 * atomic and can each use the shared pool safely on their own.
 */
export async function retireCanonicalAndPromoteReplacement(input: RetireAndPromoteInput): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`UPDATE passport_message_links SET link_status = $2 WHERE id = $1`, [
      input.oldCanonicalLinkId,
      input.oldCanonicalRetiredStatus,
    ]);

    if (input.replacementLinkId) {
      await client.query(`UPDATE passport_message_links SET role = 'canonical' WHERE id = $1`, [input.replacementLinkId]);
    }

    const { rows: retireEventRows } = await client.query<{ id: string }>(
      `INSERT INTO passport_identity_events (passport_identity_id, event_type, group_id, related_telegram_message_id, actor, operator_id, detail)
       VALUES ($1,$2,$3,$4,'operator',$5,$6)
       RETURNING id`,
      [input.passportIdentityId, input.retireEventType, input.groupId, input.relatedTelegramMessageId, input.operatorId, input.detail],
    );

    if (input.replacementLinkId && input.reassignEventType) {
      await client.query(
        `INSERT INTO passport_identity_events (passport_identity_id, event_type, group_id, related_telegram_message_id, actor, operator_id, detail)
         VALUES ($1,$2,$3,$4,'operator',$5,$6)`,
        [input.passportIdentityId, input.reassignEventType, input.groupId, input.relatedTelegramMessageId, input.operatorId, input.detail],
      );
    }

    await insertReconciliationJobWithClient(client, {
      passportIdentityId: input.passportIdentityId,
      groupId: input.groupId,
      expectedOldCanonicalTelegramMessageId: input.oldCanonicalTelegramMessageId,
      sourceOperation: input.retireEventType,
      sourceEventId: retireEventRows[0]?.id ?? null,
    });

    // Visa automation Phase 1: CANCEL_PASSPORT/REMOVE_FROM_GROUP must also
    // retire any active visa_batch_applicants assignment for this (identity,
    // group), in the SAME transaction as the domain change -- a crash right
    // after COMMIT can never leave a cancelled/removed passport still
    // "active" in a pending (or worse, already-submitted) visa batch. Never
    // called for 'moved' -- a MOVE_TO_GROUP never reaches this function at
    // all (it goes through promoteReplacementAndRelocateLink below instead,
    // which has its own, equivalent visa-retirement call for fromGroupId);
    // this guard exists purely because oldCanonicalRetiredStatus's own type
    // still includes 'moved' as a possible PassportLinkStatus value.
    if (input.oldCanonicalRetiredStatus !== 'moved') {
      await updateActiveAssignmentsStatusWithClient(client, input.groupId, input.passportIdentityId, input.oldCanonicalRetiredStatus);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface PromoteReplacementAndRelocateInput {
  /** The link actually being moved to a new group. Its role/link_status are NEVER changed here — it stays canonical/active throughout, only its group_id moves. Marking it 'moved' would make it invisible to findActiveCanonicalLink in the destination group, breaking the whole point of the move. */
  movedLinkId: string;
  toGroupId: string;
  fromGroupId: string;
  /** The remaining duplicate promoted to fill the now-vacant canonical slot in fromGroupId — null when no replacement exists (fromGroupId's Sheet row must then be deleted, handled by the caller after this transaction commits). */
  replacementLinkId: string | null;
  passportIdentityId: string;
  relatedTelegramMessageId: string;
  operatorId: string;
}

/**
 * The MOVE_TO_GROUP transactional core: promotes a replacement canonical
 * for the group being LEFT (if one exists) and relocates the moved link to
 * its new group, together with both audit events, all atomically — a
 * crash partway through must never leave fromGroupId without a canonical
 * AND without a promoted replacement, nor relocate the link without
 * recording why.
 *
 * Also enqueues exactly one sheet_reconciliation_jobs row for fromGroupId
 * (the ORIGIN'S cleanup — a delete or a reassignment onto the promoted
 * replacement, re-resolved fresh by the worker, same as every other
 * reconciliation job) IN THIS SAME transaction — the caller no longer
 * makes any direct Sheets call for the origin side. The DESTINATION side
 * (toGroupId) is a separate, ordinary append with no existing row to find,
 * and stays the caller's own responsibility exactly as before.
 */
export async function promoteReplacementAndRelocateLink(input: PromoteReplacementAndRelocateInput): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Order matters: idx_passport_message_links_one_active_canonical is
    // enforced per-statement (not deferred to COMMIT), so the moved link
    // MUST leave fromGroupId before the replacement is promoted there —
    // otherwise both rows would momentarily hold role='canonical' AND
    // link_status='active' for the SAME (identity, fromGroupId), violating
    // the constraint even within one transaction.
    await client.query(`UPDATE passport_message_links SET group_id = $2 WHERE id = $1`, [input.movedLinkId, input.toGroupId]);

    if (input.replacementLinkId) {
      await client.query(`UPDATE passport_message_links SET role = 'canonical' WHERE id = $1`, [input.replacementLinkId]);
      await client.query(
        `INSERT INTO passport_identity_events (passport_identity_id, event_type, group_id, related_telegram_message_id, actor, operator_id, detail)
         VALUES ($1,'canonical_reassigned',$2,$3,'operator',$4,$5)`,
        [input.passportIdentityId, input.fromGroupId, input.relatedTelegramMessageId, input.operatorId, 'reassigned after move_to_group'],
      );
    }

    const { rows: transferEventRows } = await client.query<{ id: string }>(
      `INSERT INTO passport_identity_events (passport_identity_id, event_type, group_id, related_telegram_message_id, actor, operator_id, detail)
       VALUES ($1,'group_transferred',$2,$3,'operator',$4,$5)
       RETURNING id`,
      [
        input.passportIdentityId,
        input.toGroupId,
        input.relatedTelegramMessageId,
        input.operatorId,
        `from=${input.fromGroupId} to=${input.toGroupId}`,
      ],
    );

    await insertReconciliationJobWithClient(client, {
      passportIdentityId: input.passportIdentityId,
      groupId: input.fromGroupId,
      expectedOldCanonicalTelegramMessageId: input.relatedTelegramMessageId,
      sourceOperation: 'move_to_group',
      sourceEventId: transferEventRows[0]?.id ?? null,
    });

    // Visa automation Phase 1: MOVE_TO_GROUP must also retire any active
    // visa_batch_applicants assignment the passport held in fromGroupId --
    // it no longer belongs to that group's VisitSaudi batch once moved, and
    // leaving it "active" there would be stale data a future batch
    // submission could wrongly include. Scoped to fromGroupId ONLY (never
    // toGroupId) -- updateActiveAssignmentsStatusWithClient's own
    // WHERE group_id = $1 AND passport_identity_id = $2 AND status = 'active'
    // guarantees this touches nothing in toGroupId and is a safe no-op when
    // no assignment exists yet (the common case today). 'removed' is used
    // because visa_batch_applicant_status has no 'moved' value -- from the
    // ORIGIN group's own perspective this passport is simply no longer
    // present, the same semantics REMOVE_FROM_GROUP's own hook already uses.
    //
    // Deliberately does NOT create a new assignment in toGroupId: that
    // group's own Sheet data may not be verified/ready yet, and doing so
    // here would silently re-run the Sheet-read/validate pipeline outside
    // the operator's own explicit /visa_assign trigger. An operator who
    // wants the moved applicant batched in toGroupId runs /visa_assign
    // there afterward -- assignVisaBatch is already idempotent, so this is
    // always a safe, explicit, separate step.
    await updateActiveAssignmentsStatusWithClient(client, input.fromGroupId, input.passportIdentityId, 'removed');

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface MergeLinkPlan {
  linkId: string;
  /** true if this loser link keeps (or gains) role='canonical' after being reassigned to the survivor; false if it becomes/stays 'duplicate'. */
  becomesCanonical: boolean;
  /** Set only when promoting this loser link requires first demoting an EXISTING survivor canonical in the same group — see mergeIdentities.ts's own doc comment for the scoring that decides this. */
  demoteSurvivorLinkId: string | null;
}

/** One same-group canonical conflict resolved by the merge — the demoted side's Sheet row is now stale and needs reconciliation. */
export interface MergeStaleSheetRow {
  groupId: string;
  telegramMessageId: string;
}

export interface MergeIdentitiesInput {
  survivorId: string;
  loserId: string;
  linkPlans: readonly MergeLinkPlan[];
  /** Computed by the caller (mergeIdentities.ts) from the SAME plan data, BEFORE this transaction — one entry per same-group conflict this merge resolves. Inserted as reconciliation jobs in this same transaction; see sheet_reconciliation_jobs's own doc comment. */
  staleSheetRows: readonly MergeStaleSheetRow[];
  operatorId: string;
}

/**
 * Identity-merge transactional core (design spec Decision N-4). For each
 * loser link, any survivor-canonical demotion happens strictly before that
 * loser link's own promotion — for the identical per-statement
 * partial-unique-index reason documented in
 * promoteReplacementAndRelocateLink above: two rows must never
 * simultaneously hold role='canonical' AND link_status='active' for the
 * same (identity, group), even momentarily within one transaction.
 * Combining passport_identity_id + role into a single UPDATE per link (as
 * done below) further guarantees a link's identity and role change
 * together, atomically, never in a transiently-invalid intermediate state.
 *
 * Also enqueues one sheet_reconciliation_jobs row per staleSheetRows entry
 * IN THIS SAME transaction — the caller no longer makes any direct Sheets
 * call at all for the merge's conflict-resolution cleanup.
 */
export async function mergeIdentitiesTransaction(input: MergeIdentitiesInput): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const plan of input.linkPlans) {
      if (plan.demoteSurvivorLinkId) {
        await client.query(`UPDATE passport_message_links SET role = 'duplicate' WHERE id = $1`, [plan.demoteSurvivorLinkId]);
      }
      const newRole: 'canonical' | 'duplicate' = plan.becomesCanonical ? 'canonical' : 'duplicate';
      await client.query(`UPDATE passport_message_links SET passport_identity_id = $2, role = $3 WHERE id = $1`, [
        plan.linkId,
        input.survivorId,
        newRole,
      ]);
    }

    await client.query(`UPDATE passport_identity SET status = 'merged', merged_into_identity_id = $2 WHERE id = $1`, [
      input.loserId,
      input.survivorId,
    ]);

    const { rows: mergeEventRows } = await client.query<{ id: string }>(
      `INSERT INTO passport_identity_events (passport_identity_id, event_type, actor, operator_id, detail)
       VALUES ($1,'identity_merged','operator',$2,$3)
       RETURNING id`,
      [input.survivorId, input.operatorId, `merged loser=${input.loserId}`],
    );

    for (const stale of input.staleSheetRows) {
      await insertReconciliationJobWithClient(client, {
        passportIdentityId: input.survivorId,
        groupId: stale.groupId,
        expectedOldCanonicalTelegramMessageId: stale.telegramMessageId,
        sourceOperation: 'merge',
        sourceEventId: mergeEventRows[0]?.id ?? null,
      });
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface SplitLinkTransactionInput {
  /** The link being split out to its own new identity. */
  linkId: string;
  newIdentityId: string;
  originalIdentityId: string;
  groupId: string;
  /** The remaining duplicate promoted to fill the now-vacant canonical slot in the ORIGINAL identity's group — null when no replacement exists. */
  replacementLinkId: string | null;
  /** True when the split link was the ORIGINAL identity's active canonical for groupId (see splitLink.ts's own wasActiveCanonical) — the only case where the original identity's group needs Sheet reconciliation at all. */
  needsOriginReconciliation: boolean;
  relatedTelegramMessageId: string;
  operatorId: string;
}

/**
 * The identity-split transactional core (your Decision: split the reverse
 * of merge). The split link's own role/link_status are set to
 * canonical/active unconditionally — a freshly split-out identity always
 * has exactly one link, so it is always that identity's canonical for its
 * group, regardless of whatever role it held under the original identity.
 *
 * Ordering follows the same per-statement partial-unique-index lesson as
 * promoteReplacementAndRelocateLink: the split link's own passport_identity_id
 * is repointed FIRST (vacating the original identity's canonical slot, if
 * it held one), and only THEN is any replacement promoted into that now-
 * vacant slot — never the reverse, which would momentarily leave two
 * active canonicals for (originalIdentityId, groupId).
 *
 * When needsOriginReconciliation, also enqueues exactly one
 * sheet_reconciliation_jobs row for (originalIdentityId, groupId), IN THIS
 * SAME transaction — the caller no longer makes any direct Sheets call for
 * the original identity's group cleanup. The NEW identity's own fresh
 * canonical is a separate, ordinary append (no existing row to find) and
 * stays the caller's own responsibility via the normal sheet_sync_queue
 * pipeline, exactly as before.
 */
export async function applySplitTransaction(input: SplitLinkTransactionInput): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`UPDATE passport_message_links SET passport_identity_id = $2, role = 'canonical' WHERE id = $1`, [
      input.linkId,
      input.newIdentityId,
    ]);

    if (input.replacementLinkId) {
      await client.query(`UPDATE passport_message_links SET role = 'canonical' WHERE id = $1`, [input.replacementLinkId]);
      await client.query(
        `INSERT INTO passport_identity_events (passport_identity_id, event_type, group_id, related_telegram_message_id, actor, operator_id, detail)
         VALUES ($1,'canonical_reassigned',$2,$3,'operator',$4,$5)`,
        [input.originalIdentityId, input.groupId, input.relatedTelegramMessageId, input.operatorId, 'reassigned after identity_split'],
      );
    }

    const { rows: splitEventRows } = await client.query<{ id: string }>(
      `INSERT INTO passport_identity_events (passport_identity_id, event_type, group_id, related_telegram_message_id, actor, operator_id, detail)
       VALUES ($1,'identity_split',$2,$3,'operator',$4,$5)
       RETURNING id`,
      [input.originalIdentityId, input.groupId, input.relatedTelegramMessageId, input.operatorId, `split_into=${input.newIdentityId}`],
    );

    if (input.needsOriginReconciliation) {
      await insertReconciliationJobWithClient(client, {
        passportIdentityId: input.originalIdentityId,
        groupId: input.groupId,
        expectedOldCanonicalTelegramMessageId: input.relatedTelegramMessageId,
        sourceOperation: 'split',
        sourceEventId: splitEventRows[0]?.id ?? null,
      });
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
