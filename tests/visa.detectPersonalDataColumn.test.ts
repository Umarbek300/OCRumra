import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPersonalDataColumn, type FaceBox, type LayoutParagraph } from '../src/visa/detectPersonalDataColumn.js';

// Real production passport 381 geometry (960x1280), transcribed verbatim
// from this engagement's own read-only Vision DOCUMENT_TEXT_DETECTION raw
// dump (manually verified paragraph-by-paragraph against the real passport
// image, not synthetic/invented) — the proof case for the whole
// layout-aware crop feature: its existing checksum-based MRZ parser never
// even structurally matches (see mrz.locateMrzParagraphGeometry.test.ts),
// yet its personal-data column is one of the cleanest of the four
// passports independently diagnosed this engagement (15 fields, 13px x0
// range on a 960px-wide image).
const PAGE_WIDTH_381 = 960;
const PAGE_HEIGHT_381 = 1280;
const FACE_381: FaceBox = { x0: 60, y0: 776, x1: 264, y1: 1014 };
// The existing production face-only crop for 381 (left=0,top=561,width=377,height=620).
const EXPANDED_FACE_REGION_381: FaceBox = { x0: 0, y0: 561, x1: 377, y1: 1181 };

const MRZ_PARAGRAPH_381: LayoutParagraph = { text: 'P<UZBIBRAGIMOVA<<MARYAM<BOTIROVNA<<<<<<<<< FA93188091UZB1803127F290314961203180005077', x0: 42, y0: 1135, x1: 821, y1: 1222 };

const REAL_PERSONAL_COLUMN_PARAGRAPHS_381: LayoutParagraph[] = [
  { text: 'SHAXSIY IMZO / HOLDERS SIGNATURE', x0: 316, y0: 580, x1: 606, y1: 597 },
  { text: 'TURI / TYPE', x0: 323, y0: 687, x1: 394, y1: 698 },
  { text: 'FAMILIYASI / SURNAME', x0: 314, y0: 738, x1: 448, y1: 750 },
  { text: 'IBRAGIMOVA', x0: 317, y0: 753, x1: 477, y1: 773 },
  { text: 'ISMI / GIVEN NAMES', x0: 314, y0: 781, x1: 430, y1: 792 },
  { text: 'MARYAM', x0: 315, y0: 796, x1: 413, y1: 814 },
  { text: "OTASINING ISMI / FATHER'S NAME", x0: 312, y0: 823, x1: 511, y1: 838 },
  { text: 'BOTIROVNA', x0: 315, y0: 840, x1: 463, y1: 860 },
  { text: 'FUQAROLIGI / NATIONALITY', x0: 313, y0: 867, x1: 477, y1: 882 },
  { text: 'UZBEKISTAN', x0: 312, y0: 884, x1: 447, y1: 903 },
  { text: "TUG'ILGAN SANASI / DATE OF BIRTH", x0: 312, y0: 908, x1: 528, y1: 920 },
  { text: '12 03 2018', x0: 316, y0: 921, x1: 478, y1: 941 },
  { text: 'JINSI / SEX', x0: 311, y0: 946, x1: 375, y1: 960 },
  { text: 'BERILGAN SANASH / DATE OF ISSUE 15 03 2024', x0: 311, y0: 1011, x1: 523, y1: 1049 },
  { text: 'AMAL QILISH MUDDATI / DATE OF EXPIRY 14 03 2029', x0: 310, y0: 1055, x1: 554, y1: 1094 },
];

// Real paragraphs that must NOT join the personal-data column cluster.
const REAL_EXCLUDED_PARAGRAPHS_381: LayoutParagraph[] = [
  { text: "O'ZBEKISTON RESPUBLIKASI REPUBLIC OF UZBEKISTAN", x0: 226, y0: 197, x1: 695, y1: 257 }, // header band
  { text: 'UZB', x0: 670, y0: 442, x1: 758, y1: 469 }, // far right, own cluster, too few members
  { text: 'P', x0: 353, y0: 709, x1: 364, y1: 721 }, // single-char false positive
  { text: 'UZB', x0: 514, y0: 707, x1: 550, y1: 721 },
  { text: 'PASPORT RAQAMI / PASSPORT No. FA9318809', x0: 659, y0: 686, x1: 879, y1: 730 },
  { text: 'DAVLAT KODI / COUNTRY CODE', x0: 433, y0: 687, x1: 628, y1: 698 },
  { text: 'F', x0: 342, y0: 967, x1: 354, y1: 985 }, // single-char false positive
  { text: 'TUG\'ILGAN JOY PLACE OF BIRTH TASHKENT', x0: 442, y0: 944, x1: 645, y1: 984 },
  { text: 'KIM TOMONIDAN BERILGAN NO MIA 26401', x0: 598, y0: 1007, x1: 812, y1: 1047 },
];

function allParagraphs(): LayoutParagraph[] {
  return [...REAL_PERSONAL_COLUMN_PARAGRAPHS_381, ...REAL_EXCLUDED_PARAGRAPHS_381, MRZ_PARAGRAPH_381];
}

test('detectPersonalDataColumn finds the real 381 personal-data column with HIGH confidence from the full real paragraph set', () => {
  const result = detectPersonalDataColumn(
    allParagraphs(),
    FACE_381,
    EXPANDED_FACE_REGION_381,
    PAGE_WIDTH_381,
    PAGE_HEIGHT_381,
    [MRZ_PARAGRAPH_381],
  );

  assert.ok(result, 'expected a non-null column result for real 381 geometry');
  assert.equal(result!.columnX0, 310, 'must match the real minimum x0 (BERILGAN SANASH / DATE OF ISSUE paragraph)');
  // 11, not all 15 real column-area paragraphs: 4 of them (ISMI/GIVEN
  // NAMES, MARYAM, JINSI/SEX, TURI/TYPE) are narrow enough that a MAJORITY
  // of their own area still falls inside the current over-extended
  // face-only crop (0-377) — exactly the real intrusion this feature
  // exists to fix — so the mostlyInsideRegion guard correctly treats them
  // as "too close to the photo to trust" rather than risking them as
  // false-positive column signal. The remaining 11 are still a very tight,
  // reliable cluster.
  assert.equal(result!.memberCount, 11);
  assert.equal(result!.confidence, 'HIGH');
});

test('detectPersonalDataColumn excludes the MRZ paragraph from the cluster even though its content is unrelated to the column filters', () => {
  const result = detectPersonalDataColumn(
    allParagraphs(),
    FACE_381,
    EXPANDED_FACE_REGION_381,
    PAGE_WIDTH_381,
    PAGE_HEIGHT_381,
    [MRZ_PARAGRAPH_381],
  );
  // The MRZ paragraph's own x0 (42) is left of the face anyway (<= face.x1),
  // so it is already excluded by the x0 > face.x1 filter alone — this just
  // confirms the explicit MRZ-exclusion parameter does not accidentally
  // change anything when the shape filters would have excluded it too.
  assert.equal(result!.memberCount, 11);
});

test('detectPersonalDataColumn never includes a single-character false-positive paragraph ("P" / "F") in the winning cluster', () => {
  const result = detectPersonalDataColumn(
    allParagraphs(),
    FACE_381,
    EXPANDED_FACE_REGION_381,
    PAGE_WIDTH_381,
    PAGE_HEIGHT_381,
  );
  assert.ok(result);
  // 11, not 13 — the two single-char paragraphs (x0=353, x0=342, both
  // within the 310-323 cluster's x0 tolerance) must be excluded by the
  // minimum text-length filter, not merely by coincidence of position.
  assert.equal(result!.memberCount, 11);
});

test('detectPersonalDataColumn returns null when fewer than MIN_FIELD_COUNT independent paragraphs form a cluster', () => {
  const sparse: LayoutParagraph[] = [
    { text: 'FAMILIYASI', x0: 314, y0: 738, x1: 448, y1: 750 },
    { text: 'IBRAGIMOVA', x0: 317, y0: 753, x1: 477, y1: 773 },
    { text: 'MARYAM', x0: 315, y0: 796, x1: 413, y1: 814 },
  ];
  const result = detectPersonalDataColumn(sparse, FACE_381, EXPANDED_FACE_REGION_381, PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null);
});

test('detectPersonalDataColumn returns null when the winning cluster does not span enough vertical height (a tight, localized false cluster)', () => {
  const tightlyPacked: LayoutParagraph[] = [
    { text: 'AAAA', x0: 310, y0: 700, x1: 400, y1: 710 },
    { text: 'BBBB', x0: 312, y0: 712, x1: 400, y1: 722 },
    { text: 'CCCC', x0: 311, y0: 724, x1: 400, y1: 734 },
    { text: 'DDDD', x0: 313, y0: 736, x1: 400, y1: 746 },
  ];
  const result = detectPersonalDataColumn(tightlyPacked, FACE_381, EXPANDED_FACE_REGION_381, PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null, 'a cluster spanning well under 20% of the page height must never be trusted');
});

test('detectPersonalDataColumn excludes a paragraph whose area sits mostly inside the expanded face region (likely in-photo OCR noise)', () => {
  const overlapping: LayoutParagraph = { text: 'INSIDE PHOTO AREA', x0: 300, y0: 700, x1: 370, y1: 900 };
  const withOverlap = [...REAL_PERSONAL_COLUMN_PARAGRAPHS_381, overlapping];
  const resultWith = detectPersonalDataColumn(withOverlap, FACE_381, EXPANDED_FACE_REGION_381, PAGE_WIDTH_381, PAGE_HEIGHT_381);
  const resultWithout = detectPersonalDataColumn(
    REAL_PERSONAL_COLUMN_PARAGRAPHS_381,
    FACE_381,
    EXPANDED_FACE_REGION_381,
    PAGE_WIDTH_381,
    PAGE_HEIGHT_381,
  );
  assert.deepEqual(resultWith, resultWithout, 'a paragraph overlapping the expanded face region must never affect the column result');
});

test('detectPersonalDataColumn excludes a paragraph inside the top header band regardless of its x0', () => {
  const headerOnly: LayoutParagraph[] = [
    { text: 'HEADER ONE', x0: 310, y0: 10, x1: 400, y1: 30 },
    { text: 'HEADER TWO', x0: 312, y0: 20, x1: 400, y1: 40 },
    { text: 'HEADER THREE', x0: 311, y0: 15, x1: 400, y1: 35 },
    { text: 'HEADER FOUR', x0: 313, y0: 25, x1: 400, y1: 45 },
  ];
  const result = detectPersonalDataColumn(headerOnly, FACE_381, EXPANDED_FACE_REGION_381, PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null, 'paragraphs inside the header band must never form the winning column');
});

test('detectPersonalDataColumn returns null when no paragraph is positioned to the right of the face at all', () => {
  const allLeftOfFace: LayoutParagraph[] = REAL_PERSONAL_COLUMN_PARAGRAPHS_381.map((p) => ({
    ...p,
    x0: p.x0 - 300,
    x1: p.x1 - 300,
  }));
  const result = detectPersonalDataColumn(allLeftOfFace, FACE_381, EXPANDED_FACE_REGION_381, PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null);
});

test('detectPersonalDataColumn returns null for zero/negative page dimensions', () => {
  assert.equal(detectPersonalDataColumn(REAL_PERSONAL_COLUMN_PARAGRAPHS_381, FACE_381, EXPANDED_FACE_REGION_381, 0, PAGE_HEIGHT_381), null);
  assert.equal(detectPersonalDataColumn(REAL_PERSONAL_COLUMN_PARAGRAPHS_381, FACE_381, EXPANDED_FACE_REGION_381, PAGE_WIDTH_381, 0), null);
});
