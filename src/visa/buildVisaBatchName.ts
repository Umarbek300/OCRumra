/**
 * Builds a VisitSaudi batch name from a group's departure date (ISO
 * "YYYY-MM-DD", exactly groups.departure_date's own format) and a batch
 * number -- e.g. "2026-10-05" + 1 -> "5.10-1". Parses the date/month
 * directly out of the ISO string (never via `new Date(...).getDate()`),
 * deliberately avoiding any timezone-dependent Date object behavior for
 * what is fundamentally just a display label, not a calendar computation.
 *
 * No leading zero on day or month (matches the day.month convention this
 * was specified with -- "5.10", never "05.10").
 *
 * The caller (assignVisaBatch.ts) is responsible for the batch's own
 * (group_id, portal, batch_number) uniqueness; this function only ever
 * formats a name, it never checks for collisions with another trip
 * departing the same day.
 */
export function buildVisaBatchName(departureDateIso: string, batchNumber: number): string {
  const match = departureDateIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    throw new Error(`buildVisaBatchName: unparseable departure date "${departureDateIso}"`);
  }
  const [, , monthStr, dayStr] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  return `${day}.${month}-${batchNumber}`;
}
