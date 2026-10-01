/**
 * Column layout for the visa-specific fields added to each group's Sheet
 * row, alongside the existing A:M passport-data table (sheetLayout.ts) and
 * the O1:P5 gender summary block (genderSummaryLayout.ts).
 *
 * Deliberately starts at Q, not N or O/P: column N is genderSummaryLayout.
 * ts's own deliberate visual gap, and O:P is the gender summary's fixed
 * block for rows 1-5 -- a per-row visa column placed there would corrupt
 * (or be corrupted by) that block for every group's first 4 data rows.
 * Q onward has no other writer anywhere in this codebase.
 */
export const VISA_NATIONALITY_COLUMN = 'Q';
export const VISA_EMAIL_COLUMN = 'R';
export const VISA_ARRIVAL_DATE_COLUMN = 'S';
export const VISA_PERSONAL_PHOTO_URL_COLUMN = 'T';
export const VISA_PASSPORT_SCAN_URL_COLUMN = 'U';

export const VISA_FIRST_COLUMN_LETTER = VISA_NATIONALITY_COLUMN;
export const VISA_LAST_COLUMN_LETTER = VISA_PASSPORT_SCAN_URL_COLUMN;

/** 0-indexed position within a row array read from A:U (A=0, ..., M=12, N=13, O=14, P=15, Q=16, R=17, S=18, T=19, U=20). */
export const VISA_COLUMN_INDEX = {
  nationality: 16,
  email: 17,
  arrivalDate: 18,
  personalPhotoUrl: 19,
  passportScanUrl: 20,
} as const;
