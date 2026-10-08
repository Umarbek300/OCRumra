import type { VisionBoundingPoly, VisionPage } from '../ocr/visual/extractIssueDateFromVisionStructure.js';

/**
 * Raw (pre-EXIF-rotation) image geometry, as read from the ORIGINAL buffer
 * — e.g. via sharp's metadata() before rotate() is ever called. `orientation`
 * is the EXIF Orientation tag (1-8); 1 or undefined means "normal", i.e. no
 * transform is needed at all.
 */
export interface RawImageGeometry {
  rawWidth: number;
  rawHeight: number;
  orientation: number | undefined;
}

export interface Point {
  x: number;
  y: number;
}

export interface NormalizedParagraph {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Maps a single point from the RAW pixel grid that Google Vision's
 * DOCUMENT_TEXT_DETECTION returns bounding-box coordinates in, into the
 * EXIF-normalized pixel grid that FACE_DETECTION's coordinates already live
 * in (see extractApplicantPhotoCrop.ts's own `sharp(buf).rotate()` call).
 *
 * Vision's annotate-image endpoints operate on the image's raw decoded
 * pixel grid — they do not themselves apply the EXIF orientation tag before
 * computing bounding boxes. sharp's rotate() (no arguments) DOES apply it,
 * physically rotating pixels and stripping the tag. Without this transform,
 * a DOCUMENT_TEXT_DETECTION-derived layout constraint (personal-data
 * column, MRZ position) would be measured in a different coordinate space
 * than the FACE_DETECTION-derived face box whenever a photo's EXIF
 * orientation tag is not the default (1), silently producing a wrong crop
 * boundary — this makes both geometries comparable without a second Vision
 * API call.
 *
 * Orientations 1 (identity), 3 (180°), 6 (90° CW) and 8 (270° CW) are
 * derived from first principles (tracking where each of the raw image's
 * four corners lands) and covered by this module's own unit tests.
 * Orientations 2/4/5/7 (mirrored) use the standard EXIF transform tables
 * for completeness but have not been observed on any real passport in this
 * system and are not covered by a dedicated test — treat a mirrored
 * orientation as lower-confidence until verified against a real sample.
 */
export function transformPointToNormalizedSpace(point: Point, geometry: RawImageGeometry): Point {
  const { rawWidth: w, rawHeight: h, orientation } = geometry;
  switch (orientation) {
    case 2: // mirror horizontal
      return { x: w - point.x, y: point.y };
    case 3: // rotate 180°
      return { x: w - point.x, y: h - point.y };
    case 4: // mirror vertical
      return { x: point.x, y: h - point.y };
    case 5: // transpose (mirror horizontal + rotate 90° CW)
      return { x: point.y, y: point.x };
    case 6: // rotate 90° CW
      return { x: h - point.y, y: point.x };
    case 7: // transverse (mirror horizontal + rotate 270° CW)
      return { x: h - point.y, y: w - point.x };
    case 8: // rotate 270° CW
      return { x: point.y, y: w - point.x };
    case 1:
    default:
      return { x: point.x, y: point.y };
  }
}

/** The EXIF-normalized image's own width/height — swapped vs. raw whenever the orientation implies a 90°/270° rotation. */
export function normalizedDimensions(geometry: RawImageGeometry): { width: number; height: number } {
  const { rawWidth, rawHeight, orientation } = geometry;
  if (orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8) {
    return { width: rawHeight, height: rawWidth };
  }
  return { width: rawWidth, height: rawHeight };
}

function getParagraphText(paragraph: { words?: { symbols?: { text?: string | null }[] | null }[] | null }): string {
  return (paragraph.words ?? [])
    .map((word) => (word.symbols ?? []).map((symbol) => symbol.text ?? '').join(''))
    .join(' ');
}

function boundingBoxPixels(box: VisionBoundingPoly | null | undefined): { xs: number[]; ys: number[] } | null {
  const vertices = box?.vertices;
  if (!vertices || vertices.length === 0) return null;
  return { xs: vertices.map((v) => v.x ?? 0), ys: vertices.map((v) => v.y ?? 0) };
}

/**
 * Flattens every paragraph across every block/page of a
 * DOCUMENT_TEXT_DETECTION response into a flat list of {text, x0,y0,x1,y1}
 * boxes, each already transformed into the EXIF-normalized coordinate
 * space via transformPointToNormalizedSpace. Paragraphs with no bounding
 * box (should not happen for a real Vision response, but never assumed)
 * are skipped, never guessed. This is the single entry point
 * detectPersonalDataColumn.ts and locateMrzParagraphGeometry.ts both
 * consume — see extractApplicantPhotoCrop.ts for how it's wired in.
 */
export function flattenParagraphsToNormalizedSpace(
  pages: readonly VisionPage[],
  geometry: RawImageGeometry,
): NormalizedParagraph[] {
  const results: NormalizedParagraph[] = [];
  for (const page of pages) {
    for (const block of page.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        const box = boundingBoxPixels(paragraph.boundingBox);
        if (!box) continue;
        const corners = box.xs.map((x, i) => transformPointToNormalizedSpace({ x, y: box.ys[i]! }, geometry));
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        results.push({
          text: getParagraphText(paragraph),
          x0: Math.min(...xs),
          y0: Math.min(...ys),
          x1: Math.max(...xs),
          y1: Math.max(...ys),
        });
      }
    }
  }
  return results;
}
