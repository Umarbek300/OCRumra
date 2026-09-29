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
 * recomputed fresh, right now, from passport_ocr_results.gender joined
 * through telegram_messages.group_id -- never an incrementally-maintained
 * counter anywhere. That is what makes this automatically correct no
 * matter how many times it is called:
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
 * Only counts messages actually linked to this group (tm.group_id = $1) --
 * an unlinked message (group_id IS NULL, not yet assigned by an operator)
 * never contributes to any group's total.
 */
export async function computeGroupGenderStats(groupId: string): Promise<GroupGenderStats> {
  const { rows } = await pool.query<GenderCountRow>(
    `SELECT por.gender::text AS gender, COUNT(*)::text AS count
     FROM passport_ocr_results por
     JOIN telegram_messages tm ON tm.id = por.telegram_message_id
     WHERE tm.group_id = $1
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
