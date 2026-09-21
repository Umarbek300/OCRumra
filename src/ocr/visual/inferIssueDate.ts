/**
 * Infers passport_issue_date by elimination: the one visual-zone date
 * candidate that isn't already accounted for by dates MRZ reliably
 * provided (dateOfBirth, passportExpiryDate). Never guesses — returns null
 * whenever the result would be ambiguous, including when there is nothing
 * already-known to eliminate against.
 */
export function inferIssueDate(candidates: string[], known: string[]): string | null {
  if (known.length === 0) return null;

  const knownDates = new Set(known);
  const unexplained = new Set(candidates.filter((candidate) => !knownDates.has(candidate)));

  if (unexplained.size !== 1) return null;

  return [...unexplained][0]!;
}
