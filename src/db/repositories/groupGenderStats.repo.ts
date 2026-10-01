import { pool } from '../pool.js';

export interface GroupGenderStats {
  male: number;
  female: number;
  /** Folds together two distinct DB states that both mean "not confidently known": a NULL gender column (Vision found no gender indicator at all) and the explicit 'unspecified' enum value. Neither is ever counted as male or female. */
  unspecified: number;
  /** Always male + female + unspecified, by construction below -- never computed or stored separately. */
  total: number;
}

interface GenderCountRow {
  gender: string | null;
  count: string;
}

/**
 * The single source of truth for a group's gender breakdown: always
 * recomputed fresh, right now, from passport_ocr_results.gender -- never an
 * incrementally-maintained counter anywhere. That is what makes this
 * automatically correct no matter how many times it is called:
 *
 *  - A sheet-sync retry recomputes the exact same true counts (nothing was
 *    ever incremented, so there is nothing to double-count).
 *  - A duplicate Telegram message never reaches this query at all --
 *    telegram_messages' own (telegram_chat_id, telegram_message_id) UNIQUE
 *    constraint (see recordPhotoMessage) already prevents a second row
 *    from ever being created for it.
 *  - A duplicate OCR attempt for the same message never reaches this query
 *    either -- passport_ocr_results.telegram_message_id is UNIQUE (see
 *    createPassportOcrResult's own idempotency), so there is at most one
 *    gender value per message, ever.
 *  - A later correction to an OCR result's gender value (an UPDATE, not a
 *    new row) is reflected correctly on the very next call, with no
 *    separate "already counted" bookkeeping to get out of sync.
 *  - Editing the Google Sheet by hand cannot desync this number, because
 *    the Sheet is never read from here -- only Postgres is.
 *
 * A message's group membership is resolved through passport_message_links
 * when one exists, NEVER through telegram_messages.group_id directly for a
 * linked message -- that column is fixed at ingest time and never updated
 * by MOVE_TO_GROUP (see passportMessageLinks.repo.ts's own
 * reassignLinkToGroup doc comment: only the link's group_id moves), so
 * using tm.group_id for a linked message would keep counting it in its
 * ORIGINAL group forever after a move. A message with no link row at all
 * (predates the duplicate-passport feature, or OCR found no usable
 * identity data) still falls back to tm.group_id -- pre-feature behavior
 * exactly preserved.
 *
 * Only ever counts the ACTIVE CANONICAL link for a passport identity within
 * a group -- role='duplicate' (an auto-merged repeat send of the same
 * passport within one group) and any non-'active' link_status (cancelled,
 * removed, or the message's own link having been relocated elsewhere via
 * MOVE_TO_GROUP) are excluded. This mirrors exactly what actually has a
 * physical row in the group's Sheet at any given moment (see
 * syncPassportRowToSheet.ts's own canonical-resolution and
 * reconcileSheetRow.ts's delete/reassign logic) -- a duplicate send, a
 * cancelled passport, or a passport moved to another group must never
 * inflate (or, for a move, leave stale in the origin group's) Jami/Erkak/
 * Ayol counts.
 */
export async function computeGroupGenderStats(groupId: string): Promise<GroupGenderStats> {
  const { rows } = await pool.query<GenderCountRow>(
    `SELECT por.gender::text AS gender, COUNT(*)::text AS count
     FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     LEFT JOIN passport_message_links pml ON pml.telegram_message_id = por.telegram_message_id
     WHERE COALESCE(pml.group_id, tm.group_id) = $1
       AND (pml.id IS NULL OR (pml.role = 'canonical' AND pml.link_status = 'active'))
     GROUP BY por.gender`,
    [groupId],
  );

  let male = 0;
  let female = 0;
  let unspecified = 0;
  for (const row of rows) {
    const count = Number(row.count);
    if (row.gender === 'male') male += count;
    else if (row.gender === 'female') female += count;
    else unspecified += count; // covers both NULL and the explicit 'unspecified' enum value
  }

  return { male, female, unspecified, total: male + female + unspecified };
}
