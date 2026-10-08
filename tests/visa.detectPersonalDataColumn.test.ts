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

// --- DISPERSION_BAD_FRACTION recalibration regression (408/409/410/414) ---
// Real production passport geometry, transcribed verbatim from this
// engagement's own read-only production diagnostic (a verbose script that
// re-implements this module's exact clustering/scoring logic and logs
// every intermediate value — never fabricated). These 4 real post-deploy
// passports revealed DISPERSION_BAD_FRACTION=0.05 (calibrated against only
// one real sample, 381) was too strict for normal real-world column
// printing variance (13-51px x0 range), leaving the right-edge constraint
// inert for most real passports. Raised to 0.10 — see the constant's own
// doc comment in detectPersonalDataColumn.ts for the exact before/after
// per passport.

function paragraph(text: string, x0: number, y0: number, x1: number, y1: number): LayoutParagraph {
  return { text, x0, y0, x1, y1 };
}

test('real passport 414 (896x1280): a noisier OCR read (x0Range=51px, includes garbled OCR fragments) improves from LOW to MEDIUM, not all the way to HIGH', () => {
  const face: FaceBox = { x0: 88, y0: 784, x1: 266, y1: 991 };
  const expandedFaceRegion: FaceBox = { x0: 0, y0: 598, x1: 364, y1: 1136 };
  const paragraphs: LayoutParagraph[] = [
    paragraph('buf-', 323, 310, 475, 405),
    paragraph('SHAXSIY IMZO / HOLDERS SI', 285, 567, 545, 593),
    paragraph('UZB', 602, 439, 679, 466),
    paragraph('DAYEXT WEEK / COUNTRY COD', 393, 660, 569, 683),
    paragraph('UZB', 467, 684, 502, 698),
    paragraph('PASPORT SAGAN PASSPORT N', 596, 650, 781, 670),
    paragraph('FA7811218', 638, 672, 770, 696),
    paragraph('TOSHMATOVA', 300, 731, 451, 760),
    paragraph('BAKHROMOVNA', 307, 810, 472, 840),
    paragraph('FUGAOLATIONALITY UZBEKIST', 295, 833, 447, 877),
    paragraph('ENGAN SANAS TE P', 312, 869, 460, 892),
    paragraph('11 04 1964', 311, 885, 463, 914),
    paragraph('TASHKENT', 440, 918, 561, 945),
    paragraph('GAN SANAM DATE OF LE', 336, 963, 498, 986),
    paragraph('25 05 2023 AMAL QILISH MI', 307, 980, 533, 1053),
    paragraph('MIA 26291', 584, 963, 723, 994),
  ];

  const result = detectPersonalDataColumn(paragraphs, face, expandedFaceRegion, 896, 1280);

  assert.ok(result);
  assert.equal(result!.columnX0, 285);
  assert.equal(result!.memberCount, 9);
  assert.equal(result!.confidence, 'MEDIUM', 'genuine OCR-garbage members keep this below HIGH even after the recalibration');
});

test('real passport 410 (960x1280): a clean 12-member cluster (x0Range=22px) now reaches HIGH (was MEDIUM before recalibration)', () => {
  const face: FaceBox = { x0: 151, y0: 805, x1: 322, y1: 1004 };
  const expandedFaceRegion: FaceBox = { x0: 57, y0: 626, x1: 416, y1: 1143 };
  const paragraphs: LayoutParagraph[] = [
    paragraph('SHAXSIY IMZO / HOLDERS SI', 355, 598, 623, 617),
    paragraph('UZB', 685, 466, 767, 493),
    paragraph('DAVLAT KODI / COUNTRY COR', 464, 699, 648, 715),
    paragraph('UZB', 540, 722, 574, 734),
    paragraph('PASEORT RAQAMI / PASSPORT', 675, 690, 884, 708),
    paragraph('FB1836969', 713, 717, 851, 740),
    paragraph('FAMILIYASI SURNAME', 355, 753, 481, 768),
    paragraph('ABDUVALIEVA', 361, 768, 529, 790),
    paragraph("OTASINING ISMI FATHER'S N", 359, 832, 543, 847),
    paragraph('RASHIDOVNA', 365, 849, 516, 868),
    paragraph('FUQAROLIGI / NATIONALITY', 362, 872, 512, 886),
    paragraph('UZBEKISTAN', 363, 889, 487, 903),
    paragraph("TUG'ILGAN SANASI / DATE O", 363, 905, 560, 919),
    paragraph('13 07 1969', 371, 920, 518, 937),
    paragraph("TUG'ILGAN JOYI / PLACE OF", 484, 939, 672, 951),
    paragraph('TASHKENT', 497, 956, 616, 974),
    paragraph('BERILGAN SANASI / DATE OF', 370, 993, 559, 1006),
    paragraph('08 11 2025', 377, 1009, 522, 1027),
    paragraph('AMAL QILISH MUDDATI DATE ', 371, 1026, 591, 1062),
    paragraph('KIM TOMONIDAN BERILGAN AU', 629, 997, 857, 1006),
    paragraph('PSC 60001', 640, 1015, 778, 1031),
  ];

  const result = detectPersonalDataColumn(paragraphs, face, expandedFaceRegion, 960, 1280);

  assert.ok(result);
  assert.equal(result!.columnX0, 355);
  assert.equal(result!.memberCount, 12);
  assert.equal(result!.confidence, 'HIGH', 'a clean 22px-dispersion cluster must reach HIGH after the recalibration');
});

test('real passport 409 (960x1280): a tight 7-member cluster (x0Range=13px) stays HIGH, even more comfortably than before', () => {
  const face: FaceBox = { x0: 115, y0: 809, x1: 332, y1: 1061 };
  const expandedFaceRegion: FaceBox = { x0: 0, y0: 582, x1: 451, y1: 1237 };
  const paragraphs: LayoutParagraph[] = [
    paragraph('SHAXSIY IMZO / HOLDERS SI', 364, 598, 654, 615),
    paragraph('UZB', 720, 463, 813, 491),
    paragraph('DAVLAT KODI / COUNTRY COD', 482, 705, 676, 722),
    paragraph('UZB', 564, 730, 601, 742),
    paragraph('PASPORT RAQAMI / PASSPORT', 707, 697, 918, 715),
    paragraph('FB1836966', 744, 722, 884, 746),
    paragraph("OTASINING ISMI FATHER'S N", 363, 844, 563, 865),
    paragraph("TUG'ILGAN SANASI / DATE O", 366, 919, 576, 939),
    paragraph('14 12 1965', 373, 934, 533, 959),
    paragraph("TUG'ILGAN JOYI / PLACE OF", 494, 949, 690, 968),
    paragraph('TASHKENT', 508, 966, 634, 989),
    paragraph('BERILGAN SANASI / DATE OF', 369, 1007, 570, 1028),
    paragraph('08 11 2025', 376, 1024, 533, 1048),
    paragraph('AMAL QILISH MUDDATI / DAT', 370, 1041, 601, 1083),
    paragraph('2035', 471, 1060, 534, 1078),
    paragraph('KIM TOMONIDAN BERILGAN / ', 642, 995, 867, 1038),
  ];

  const result = detectPersonalDataColumn(paragraphs, face, expandedFaceRegion, 960, 1280);

  assert.ok(result);
  assert.equal(result!.columnX0, 363);
  assert.equal(result!.memberCount, 7);
  assert.equal(result!.confidence, 'HIGH');
});

test('real passport 408 (960x1280): a 14-member cluster (x0Range=30px) reaches HIGH at D=0.11 (was LOW at D=0.05, MEDIUM at D=0.10)', () => {
  const face: FaceBox = { x0: 135, y0: 770, x1: 312, y1: 975 };
  const expandedFaceRegion: FaceBox = { x0: 38, y0: 586, x1: 410, y1: 1119 };
  const paragraphs: LayoutParagraph[] = [
    paragraph('SHAXSIY IMZO / HOLDERS SI', 346, 581, 622, 603),
    paragraph('UZB', 676, 445, 761, 472),
    paragraph('FB1836885', 822, 109, 896, 564),
    paragraph('DAVLAT KODI / COUNTRY COD', 462, 678, 648, 700),
    paragraph('PASPORT RAQAMI PASSPORT N', 678, 665, 888, 688),
    paragraph('FB1836885', 715, 693, 855, 718),
    paragraph('FAMILIYASI / SURNAME', 350, 737, 480, 756),
    paragraph('NODIROV', 355, 756, 467, 779),
    paragraph('AVAZKHON', 358, 795, 484, 819),
    paragraph("OTASINING ISMI FATHER'S N", 354, 819, 545, 839),
    paragraph('BOSITKHON UGLI', 360, 832, 581, 862),
    paragraph('FUQAROLIGI / NATIONALITY', 358, 861, 515, 879),
    paragraph('UZBEKISTAN', 359, 878, 487, 898),
    paragraph("TUG'ILGAN SANASI / DATE O", 359, 896, 564, 914),
    paragraph('06 08 1990', 366, 912, 520, 935),
    paragraph("TUG'ILGAN JOYI / ACE OF B", 485, 926, 681, 969),
    paragraph('BERILGAN SANASI / DATE OF', 366, 990, 563, 1008),
    paragraph('08 11 2025', 372, 1007, 526, 1029),
    paragraph('AMAL QILISH MUDDATI DATE ', 369, 1027, 597, 1044),
    paragraph('07 11 2035', 376, 1045, 529, 1067),
    paragraph('KIM TOMONIDAN BERILGAN / ', 636, 982, 870, 1000),
    paragraph('PSC 60001', 648, 1001, 789, 1023),
  ];

  const result = detectPersonalDataColumn(paragraphs, face, expandedFaceRegion, 960, 1280);

  assert.ok(result);
  assert.equal(result!.columnX0, 346);
  assert.equal(result!.memberCount, 14);
  assert.equal(result!.confidence, 'HIGH', 'D=0.11 was chosen specifically to clear 408\'s dispersionScore=0.7 cutoff with a small margin');
});
