/**
 * Country-of-birth/residence lookup for VisitSaudi, keyed by the
 * applicant's Sheet nationality value (VerifiedApplicantData.nationality).
 * Exhaustive only for the nationalities explicitly confirmed by the
 * operator -- an unrecognized value is never guessed or defaulted, since a
 * wrong Country/City of Birth on a real visa application is a worse
 * outcome than stopping and asking.
 */

export interface CountryCapitalEntry {
  country: string;
  capitalCity: string;
}

const COUNTRY_CAPITAL_LOOKUP: Readonly<Record<string, CountryCapitalEntry>> = {
  UZBEKISTAN: { country: 'UZBEKISTAN', capitalCity: 'Tashkent' },
  TAJIKISTAN: { country: 'TAJIKISTAN', capitalCity: 'Dushanbe' },
};

export type LookupCountryCapitalResult = { ok: true; entry: CountryCapitalEntry } | { ok: false; reason: 'UNKNOWN_NATIONALITY' };

/**
 * Case/whitespace-insensitive exact match against the confirmed
 * nationality list above -- never a fuzzy or partial match, and never a
 * fallback to any other value for a nationality not explicitly confirmed.
 */
export function lookupCountryCapital(nationality: string): LookupCountryCapitalResult {
  const normalized = nationality.trim().toUpperCase();
  const entry = COUNTRY_CAPITAL_LOOKUP[normalized];
  if (!entry) {
    return { ok: false, reason: 'UNKNOWN_NATIONALITY' };
  }
  return { ok: true, entry };
}
