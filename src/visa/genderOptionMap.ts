/**
 * Maps the Sheet's own gender label (see buildSheetRow.ts's GENDER_LABELS
 * -- 'Erkak' (male) / 'Ayol' (female) / '' (unspecified)) to VisitSaudi's
 * real `Gender*` dropdown option text -- confirmed from a recovered
 * real-portal screenshot showing "Male" as a FILLED-IN selected value
 * (not just the category name). Never guesses for a blank or
 * unrecognized gender value. Mirrors genderProfessionMap.ts's own
 * structure and input exactly -- same Sheet value, different portal
 * target field.
 */

export type GenderOptionForVisitSaudi = 'Male' | 'Female';

export type MapGenderToVisitSaudiOptionResult =
  | { ok: true; genderOption: GenderOptionForVisitSaudi }
  | { ok: false; reason: 'UNRECOGNIZED_GENDER' };

export function mapGenderToVisitSaudiOption(genderLabel: string): MapGenderToVisitSaudiOptionResult {
  const trimmed = genderLabel.trim();
  if (trimmed === 'Erkak') {
    return { ok: true, genderOption: 'Male' };
  }
  if (trimmed === 'Ayol') {
    return { ok: true, genderOption: 'Female' };
  }
  return { ok: false, reason: 'UNRECOGNIZED_GENDER' };
}
