import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectDocumentBoundary,
  type BoundaryParagraph,
  type LooseFaceAnnotation,
} from '../src/visa/detectDocumentBoundary.js';

/**
 * Regression coverage for the Variant 3 relative tie-break added to
 * detectDocumentBoundary()'s face-inclusion loop: when 2+ faces pass the
 * SAME (unchanged, FACE_PROXIMITY_MARGIN_FACTOR = 0.5) proximity window at
 * once, only the candidate whose center sits closest to the text union's
 * own bounding box (score = hypot(excessX, excessY), 0 when the center
 * falls inside it) is unioned into the boundary; every other candidate is
 * treated exactly like an already-excluded face (eligible for Formula
 * A/C's own margin tightening). 0 or 1 included candidate, or an exact
 * score tie among 2+, is untouched old behavior.
 *
 * Deliberately a SEPARATE file from visa.detectDocumentBoundary.test.ts
 * (left untouched) rather than appended to it.
 *
 * No Vision API, network, or DB access -- pure function calls against
 * hand-built fixtures, same convention as visa.detectDocumentBoundary.test.ts.
 */

function paragraph(text: string, x0: number, y0: number, x1: number, y1: number): BoundaryParagraph {
  return { text, x0, y0, x1, y1 };
}

function face(x0: number, y0: number, x1: number, y1: number, confidence = 0.95): LooseFaceAnnotation {
  return {
    boundingPoly: {
      vertices: [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
    },
    detectionConfidence: confidence,
  };
}

function fullyInside(box: { x0: number; y0: number; x1: number; y1: number }, region: { x0: number; y0: number; x1: number; y1: number }): boolean {
  return box.x0 >= region.x0 && box.y0 >= region.y0 && box.x1 <= region.x1 && box.y1 <= region.y1;
}

// --- 1. msg_430 regression: real 2-face "held in hand" production sample ---

test('Variant 3 / msg_430: applicant (score 0, center inside text union) is included, holder (score > 0, center outside) is excluded', () => {
  // Real geometry from production message msg_430 (1280x1145). Text union
  // (51,202)-(744,1021); holder face far to the upper-right, applicant
  // face (the passport's own printed photo) lower-left, inside the text
  // column's own horizontal span.
  const paragraphs = [
    paragraph('AA', 51, 202, 400, 300),
    paragraph('BB', 400, 202, 744, 300),
    paragraph('CC', 51, 900, 400, 1021),
    paragraph('DD', 400, 900, 744, 1021),
    paragraph('EE', 51, 500, 744, 600),
  ];
  const holder = { x0: 692, y0: 178, x1: 1151, y1: 711 };
  const applicant = { x0: 73, y0: 665, x1: 250, y1: 872 };
  const faces = [face(holder.x0, holder.y0, holder.x1, holder.y1), face(applicant.x0, applicant.y0, applicant.x1, applicant.y1)];

  const result = detectDocumentBoundary(paragraphs, faces, 1280, 1145);

  assert.ok(result, 'expected a non-null boundary for msg_430');
  if (!result) return;

  // Both faces individually pass the (unchanged) proximity window -- this
  // is exactly the 2-candidate case the tie-break exists for.
  assert.ok(Math.abs(result.x0 - 0) < 0.5, `expected x0 ~ 0, got ${result.x0}`);
  assert.ok(Math.abs(result.y0 - 202) < 0.5, `expected y0 ~ 202, got ${result.y0}`);
  assert.ok(Math.abs(result.x1 - 744) < 0.5, `expected x1 ~ 744, got ${result.x1}`);
  assert.ok(Math.abs(result.y1 - 1066.8) < 0.5, `expected y1 ~ 1066.8, got ${result.y1}`);

  // The applicant face (the real content) must be fully contained.
  assert.ok(fullyInside(applicant, result), 'applicant face must remain fully inside the final boundary');

  // The holder must NOT have been unioned in: its own x1 (1151) lies far
  // beyond the final boundary's x1, which would be impossible if it had
  // been included (the union would have stretched to cover it, then been
  // expanded further by the 4% margin).
  assert.ok(!fullyInside(holder, result), 'holder face must not be fully inside the final boundary (it was excluded, not unioned in)');
  assert.ok(result.x1 < holder.x1, 'boundary x1 must stop well short of the holder face, proving it was never unioned in');
});

// --- 2. Single included face: tie-break must never engage ---

test('Variant 3 / single candidate: with only one face passing the proximity window, behavior is identical to the pre-tie-break union', () => {
  const paragraphs = [
    paragraph('AA', 100, 100, 250, 150),
    paragraph('BB', 250, 100, 400, 150),
    paragraph('CC', 100, 350, 250, 400),
    paragraph('DD', 250, 350, 400, 400),
  ];
  // Single face, comfortably inside the proximity window, that also
  // extends the raw union beyond the text's own bounds on every side.
  const applicantFace = face(150, 350, 300, 450);
  const result = detectDocumentBoundary(paragraphs, [applicantFace], 1000, 1000);

  assert.ok(result, 'expected a non-null boundary');
  if (!result) return;

  // Hand-computed expectation: text union (100,100)-(400,400); the single
  // face is included (unchanged), expanding the union to
  // (100,100)-(400,450); no excluded faces, so Formula A/C is a no-op;
  // final boundary is that union +/- the fixed 4% margin of the 1000x1000
  // frame (40px each side), clamped to the image.
  assert.equal(result.x0, 60);
  assert.equal(result.y0, 60);
  assert.equal(result.x1, 440);
  assert.equal(result.y1, 490);
});

// --- 3. Exact score tie among 2+ candidates: must fall back to the old union-all behavior ---

test('Variant 3 / exact tie: two candidates with identical distance-to-text-union scores are BOTH unioned in, neither is excluded', () => {
  const paragraphs = [
    paragraph('AA', 200, 200, 240, 220),
    paragraph('BB', 260, 200, 300, 220),
    paragraph('CC', 200, 280, 240, 300),
    paragraph('DD', 260, 280, 300, 300),
  ];
  // Text union: (200,200)-(300,300).
  // Face A's center (170,170) sits 30px outside the text union on BOTH
  // axes (above and to the left) -> excessX=30, excessY=30, score=hypot(30,30).
  // Face B's center (330,330) sits 30px outside on BOTH axes (below and
  // to the right) -> excessX=30, excessY=30, score=hypot(30,30) -- an
  // EXACT tie with Face A by construction (symmetric offsets).
  const faceA = face(140, 140, 220, 220);
  const faceB = face(280, 280, 360, 360);

  const result = detectDocumentBoundary(paragraphs, [faceA, faceB], 700, 700);

  assert.ok(result, 'expected a non-null boundary');
  if (!result) return;

  // If the tie-break had (incorrectly) picked a single winner, the
  // boundary would only reach as far as ONE of the two faces' own extent.
  // Old/tie-preserved behavior unions BOTH in: content union becomes
  // (140,140)-(360,360), then +/- the fixed 4% margin of 700 (28px),
  // clamped to the image.
  assert.equal(result.x0, 112, `expected both tied faces unioned in (x0=112), got ${result.x0}`);
  assert.equal(result.y0, 112, `expected both tied faces unioned in (y0=112), got ${result.y0}`);
  assert.equal(result.x1, 388, `expected both tied faces unioned in (x1=388), got ${result.x1}`);
  assert.equal(result.y1, 388, `expected both tied faces unioned in (y1=388), got ${result.y1}`);
});

// --- 4. held-in-hand fixture: tie-break must never engage (holder fails the proximity window on its own) ---

test('Variant 3 / held-in-hand fixture: holder already fails the proximity window independently, so the tie-break never activates and the boundary is unchanged', () => {
  const paragraphs = [
    paragraph('AA', 480, 850, 620, 960),
    paragraph('BB', 620, 850, 760, 960),
    paragraph('CC', 480, 960, 620, 1070),
    paragraph('DD', 620, 960, 760, 1070),
  ];
  const holder = { x0: 500, y0: 60, x1: 900, y1: 460 };
  const applicant = { x0: 300, y0: 850, x1: 480, y1: 1100 };
  const faces = [face(holder.x0, holder.y0, holder.x1, holder.y1), face(applicant.x0, applicant.y0, applicant.x1, applicant.y1)];

  const result = detectDocumentBoundary(paragraphs, faces, 1000, 1400);

  assert.ok(result, 'expected a non-null boundary');
  if (!result) return;

  // Only the applicant ever becomes an "included candidate" here (the
  // holder's center fails the Y-axis proximity check on its own, same as
  // before Variant 3 existed) -- includedCandidates.length stays at 1, so
  // the tie-break code path is never entered. This must reproduce the
  // EXACT pre-Variant-3 boundary.
  assert.equal(result.x0, 260);
  assert.equal(result.y0, 794);
  assert.equal(result.x1, 760);
  assert.equal(result.y1, 1156);
});

// --- 5. Formula A/C integration: an excluded tie-break loser is still correctly tightened against, never cutting real content ---

test('Variant 3 + Formula A/C integration: the tie-break loser (holder) pushed into excludedFaceBoxes is tightened against without cutting the applicant content', () => {
  const paragraphs = [
    paragraph('AA', 51, 202, 400, 300),
    paragraph('BB', 400, 202, 744, 300),
    paragraph('CC', 51, 900, 400, 1021),
    paragraph('DD', 400, 900, 744, 1021),
    paragraph('EE', 51, 500, 744, 600),
  ];
  const holder = { x0: 692, y0: 178, x1: 1151, y1: 711 };
  const applicant = { x0: 73, y0: 665, x1: 250, y1: 872 };
  const faces = [face(holder.x0, holder.y0, holder.x1, holder.y1), face(applicant.x0, applicant.y0, applicant.x1, applicant.y1)];

  const result = detectDocumentBoundary(paragraphs, faces, 1280, 1145);

  assert.ok(result, 'expected a non-null boundary');
  if (!result) return;

  // Without Formula A, the raw margin-only x1 would be textX1 (744) + 4%
  // of 1280 (51.2) = 795.2 -- deliberately reaching into the holder's own
  // box (which starts at x0=692). Formula A must pull x1 back from 795.2
  // down to exactly the content union's own x1 (744, the text union's own
  // edge -- the applicant face doesn't extend past it), proving the
  // tie-break loser was handed to Formula A/C exactly like any other
  // excluded face, and that the tightening never cuts past real content.
  assert.equal(result.x1, 744, `expected Formula A to tighten x1 to the content boundary (744), got ${result.x1}`);
  assert.ok(result.x1 < 795.2, 'x1 must be pulled back from the untightened margin-only edge');

  // The applicant's own content must never be cut by this tightening.
  assert.ok(fullyInside(applicant, result), 'applicant content must remain fully inside the boundary after Formula A/C tightening');
});
