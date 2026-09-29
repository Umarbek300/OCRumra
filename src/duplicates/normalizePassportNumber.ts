/**
 * Normalizes a raw OCR'd passport number for identity-key comparison
 * (passport_identity.passport_number_normalized).
 *
 * Applies EXACTLY two transformations, per the finalized design decision:
 *   1. Uppercase.
 *   2. Strip whitespace (all whitespace characters, anywhere in the
 *      string — not just leading/trailing, since a stray internal space
 *      from OCR noise, e.g. "AB 123456", is the realistic case this
 *      guards against).
 *
 * Deliberately does NOT:
 *   - strip leading zeros,
 *   - change any other letter or digit,
 *   - remove punctuation,
 *   - transliterate characters,
 *   - apply undocumented substitutions such as O->0 or I->1.
 *
 * Any further normalization rule beyond these two steps must be its own
 * separately documented, separately tested change to this function — never
 * an ad-hoc adjustment at a call site. This is the ONLY place passport
 * number normalization happens in this codebase; every caller (OCR
 * completion integration, operator command processing) MUST route through
 * this function rather than reimplementing normalization inline, since the
 * passport_identity UNIQUE(passport_number_normalized, date_of_birth)
 * constraint's correctness depends entirely on this being applied
 * identically everywhere.
 */
export function normalizePassportNumber(rawValue: string): string {
  return rawValue.toUpperCase().replace(/\s+/g, '');
}
