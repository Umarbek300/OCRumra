import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateMrzParagraphGeometry, type LayoutParagraph } from '../src/ocr/mrz/locateMrzParagraphGeometry.js';
import { findMrzCandidateWindows } from '../src/ocr/mrz/findMrzCandidateWindows.js';
import { selectMrzCandidateWinner } from '../src/ocr/mrz/selectMrzCandidateWinner.js';

// Real production passport 381 geometry (960x1280), transcribed verbatim
// from this engagement's own read-only Vision raw-dump diagnostic — the
// proof case this module exists for.
const PAGE_WIDTH_381 = 960;
const PAGE_HEIGHT_381 = 1280;

const MRZ_PARAGRAPH_381: LayoutParagraph = {
  text: 'P<UZBIBRAGIMOVA<<MARYAM<BOTIROVNA<<<<<<<<< FA93188091UZB1803127F290314961203180005077',
  x0: 42,
  y0: 1135,
  x1: 821,
  y1: 1222,
};

// The real personal-data column's own VALUE paragraphs (same page) — used
// here only for the identity cross-check, exactly as
// extractApplicantPhotoCrop.ts wires it (the full flattened paragraph list,
// not a hand-picked subset).
const IDENTITY_PARAGRAPHS_381: LayoutParagraph[] = [
  { text: 'FAMILIYASI / SURNAME', x0: 314, y0: 738, x1: 448, y1: 750 },
  { text: 'IBRAGIMOVA', x0: 317, y0: 753, x1: 477, y1: 773 },
  { text: 'ISMI / GIVEN NAMES', x0: 314, y0: 781, x1: 430, y1: 792 },
  { text: 'MARYAM', x0: 315, y0: 796, x1: 413, y1: 814 },
  { text: "OTASINING ISMI / FATHER'S NAME", x0: 312, y0: 823, x1: 511, y1: 838 },
  { text: 'BOTIROVNA', x0: 315, y0: 840, x1: 463, y1: 860 },
  { text: 'FUQAROLIGI / NATIONALITY', x0: 313, y0: 867, x1: 477, y1: 882 },
  { text: 'UZBEKISTAN', x0: 312, y0: 884, x1: 447, y1: 903 }, // deliberately NOT a substring of the MRZ (only "UZB" appears there) — must not count
];

function allParagraphs(): LayoutParagraph[] {
  return [MRZ_PARAGRAPH_381, ...IDENTITY_PARAGRAPHS_381];
}

test('381 proof case: the real MRZ paragraph is confirmed HIGH via geometry + identity consistency alone, with no checksum help', () => {
  // Confirms, independently of this module, that production's own
  // checksum-based detector genuinely fails to even structurally parse
  // this real OCR read — this is the whole reason locateMrzParagraphGeometry
  // exists.
  const rawLine1 = 'P<UZBIBRAGIMOVA<<MARYAM<BOTIROVNA<<<<<<<<<'; // 42 chars, 2 short of TD3's 44
  const rawLine2 = 'FA93188091UZB1803127F290314961203180005077'; // 42 chars
  const windows = findMrzCandidateWindows([rawLine1, rawLine2].join('\n'));
  const { validWinner, firstStructuralMatch } = selectMrzCandidateWinner(windows);
  assert.equal(validWinner, null, 'sanity check: production checksum validator must fail for this real OCR read');
  assert.equal(firstStructuralMatch, null, 'sanity check: it must fail to even structurally parse, not just fail checksum');

  const result = locateMrzParagraphGeometry(allParagraphs(), PAGE_WIDTH_381, PAGE_HEIGHT_381);

  assert.ok(result, 'expected a non-null MRZ geometry result from geometry + identity alone');
  assert.equal(result!.top, 1135);
  assert.equal(result!.confidence, 'HIGH');
});

test('checksumValidated=true always yields HIGH confidence, regardless of the geometry/identity signals', () => {
  const weakParagraph: LayoutParagraph = { text: 'P<XXXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', x0: 100, y0: 700, x1: 900, y1: 720 };
  const result = locateMrzParagraphGeometry([weakParagraph], 1000, 1000, true);
  assert.ok(result);
  assert.equal(result!.confidence, 'HIGH');
});

test('a lone single-character paragraph ("P") is never mistaken for the MRZ — the exact bug this engagement\'s own earlier automated matching hit', () => {
  const result = locateMrzParagraphGeometry([{ text: 'P', x0: 353, y0: 1150, x1: 364, y1: 1162 }], PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null);
});

test('a lone single-character paragraph ("F") is never mistaken for the MRZ', () => {
  const result = locateMrzParagraphGeometry([{ text: 'F', x0: 342, y0: 1150, x1: 354, y1: 1162 }], PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null);
});

test('a wide paragraph positioned in the TOP half of the page is never treated as MRZ, however MRZ-shaped its text is', () => {
  const headerBanner: LayoutParagraph = {
    text: 'P<UZBSOMENAME<<SOMEOTHERNAME<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    x0: 50,
    y0: 50, // top of the page, not bottom
    x1: 900,
    y1: 80,
  };
  const result = locateMrzParagraphGeometry([headerBanner], PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null, 'MRZ is architecturally always near the bottom of a TD3 passport');
});

test('a narrow paragraph (less than half the page width) near the bottom is never treated as MRZ', () => {
  const narrowBottomField: LayoutParagraph = {
    text: 'KIM TOMONIDAN BERILGAN NO MIA 26401 SOME EXTRA TEXT HERE TOO LONG',
    x0: 598,
    y0: 1150,
    x1: 812, // width 214, well under half of 960
    y1: 1200,
  };
  const result = locateMrzParagraphGeometry([narrowBottomField], PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null);
});

test('a bottom, full-width paragraph that does not start with "P<" and has no long MRZ-alphabet run is never treated as MRZ', () => {
  const ordinaryWideFooter: LayoutParagraph = {
    text: 'this is just an ordinary printed footer sentence with regular words and spaces in it',
    x0: 50,
    y0: 1200,
    x1: 900,
    y1: 1230,
  };
  const result = locateMrzParagraphGeometry([ordinaryWideFooter], PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null);
});

test('without the identity cross-check, a shape-only MRZ-like candidate is at most MEDIUM confidence, never HIGH, when checksum is absent', () => {
  // Same shape as the real 381 MRZ (P<, wide, bottom, long alphabet run,
  // plausible length) but with NO corroborating identity paragraphs at all
  // — confidence must not reach HIGH on shape alone.
  const result = locateMrzParagraphGeometry([MRZ_PARAGRAPH_381], PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.ok(result);
  assert.notEqual(result!.confidence, 'HIGH', 'shape alone, without identity corroboration or checksum, must not reach HIGH');
});

test('a short identity token (e.g. a 3-letter country code) never counts toward the minimum identity-match requirement', () => {
  const shortTokenOnly: LayoutParagraph[] = [MRZ_PARAGRAPH_381, { text: 'UZB', x0: 670, y0: 442, x1: 758, y1: 469 }];
  const result = locateMrzParagraphGeometry(shortTokenOnly, PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.ok(result);
  assert.notEqual(result!.confidence, 'HIGH', 'a single short token must never be enough to confirm identity consistency');
});

test('returns null when no paragraph survives the candidate filters at all', () => {
  const result = locateMrzParagraphGeometry([{ text: 'nothing MRZ-shaped here', x0: 0, y0: 0, x1: 50, y1: 20 }], PAGE_WIDTH_381, PAGE_HEIGHT_381);
  assert.equal(result, null);
});

test('returns null for zero/negative page dimensions', () => {
  assert.equal(locateMrzParagraphGeometry(allParagraphs(), 0, PAGE_HEIGHT_381), null);
  assert.equal(locateMrzParagraphGeometry(allParagraphs(), PAGE_WIDTH_381, 0), null);
});
