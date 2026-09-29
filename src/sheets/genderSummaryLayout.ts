/**
 * Layout for the per-group gender summary block, written into a small,
 * fixed side area of the SAME sheet as the A:M passport data table (see
 * sheetLayout.ts) -- far enough past column M (the technical id column)
 * that it can never overlap with, or be shifted by, the data table's own
 * append/update logic in upsertRowInSheet.ts, which only ever touches
 * A:M. Column N is left as a deliberate visual gap.
 */
export const GENDER_SUMMARY_LABEL_COLUMN = 'O';
export const GENDER_SUMMARY_VALUE_COLUMN = 'P';

export const GENDER_SUMMARY_TITLE_ROW = 1;
export const GENDER_SUMMARY_TOTAL_ROW = 2;
export const GENDER_SUMMARY_MALE_ROW = 3;
export const GENDER_SUMMARY_FEMALE_ROW = 4;
export const GENDER_SUMMARY_UNSPECIFIED_ROW = 5;

export const GENDER_SUMMARY_RANGE =
  `${GENDER_SUMMARY_LABEL_COLUMN}${GENDER_SUMMARY_TITLE_ROW}:` +
  `${GENDER_SUMMARY_VALUE_COLUMN}${GENDER_SUMMARY_UNSPECIFIED_ROW}`;
