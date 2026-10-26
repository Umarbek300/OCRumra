/**
 * Maps the Sheet's own gender label (see buildSheetRow.ts's GENDER_LABELS
 * -- 'Erkak' (male) / 'Ayol' (female) / '' (unspecified)) to VisitSaudi's
 * required Profession value. Never guesses a profession for a blank or
 * unrecognized gender value.
 */

export type ProfessionForVisitSaudi = 'WORKER' | 'HOUSE WIFE';

export type MapGenderToProfessionResult = { ok: true; profession: ProfessionForVisitSaudi } | { ok: false; reason: 'UNRECOGNIZED_GENDER' };

export function mapGenderToProfessionForVisitSaudi(genderLabel: string): MapGenderToProfessionResult {
  const trimmed = genderLabel.trim();
  if (trimmed === 'Erkak') {
    return { ok: true, profession: 'WORKER' };
  }
  if (trimmed === 'Ayol') {
    return { ok: true, profession: 'HOUSE WIFE' };
  }
  return { ok: false, reason: 'UNRECOGNIZED_GENDER' };
}
