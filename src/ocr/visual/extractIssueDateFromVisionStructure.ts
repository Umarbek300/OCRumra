import { isRealCalendarDate } from '../passportExtractionSchema.js';

/**
 * Recovers passport_issue_date from Google Cloud Vision's structured
 * block/paragraph/word/symbol response — the same single
 * documentTextDetection() call already made for MRZ extraction, reused
 * here at zero extra API cost. MRZ structurally cannot carry issue date
 * (see mapMrzToExtractionResult.ts); this is the only source for it.
 *
 * Real messages 270 and 271 (diagnosed via
 * scripts/tmp-diagnostic-google-vision-*.ts, never committed/deployed)
 * showed Vision segments a printed "DD MM YYYY" date as three SEPARATE
 * all-digit words — not a merged token, not a textual month name — which
 * is why the flat-fullText, punctuation-separator-based
 * extractDateCandidates() (src/ocr/visual/extractDateCandidates.ts) finds
 * nothing for these documents: three space-joined words have no '.', '/',
 * or '-' between them. This module works structurally instead: it finds
 * every [2-digit, 2-digit, 4-digit] word triple that sits on the same
 * horizontal row anywhere on the page, and maps each to the nearest
 * ISSUE/ISSUED label word by bounding-box distance — deliberately not
 * hardcoded to any specific block index, since that was only ever a
 * debugging shortcut for two specific real documents, not a structural
 * guarantee for every passport.
 *
 * Never guesses: returns null whenever the result would be ambiguous
 * (no date row, no ISSUE label, an invalid calendar date, or a row that
 * turns out to equal an already-known MRZ date — the last case guards
 * against a wrong label-to-row mapping silently mislabeling the actual
 * date of birth or expiry date as the issue date).
 */

// --- Minimal structural view of Vision's response shape --------------------
// Deliberately loose/local (not the full proto types) so this stays
// trivially unit-testable with synthetic fixtures, while remaining
// structurally compatible with the real
// protos.google.cloud.vision.v1.IPage/IBlock/IParagraph/IWord/ISymbol shapes.

export interface VisionVertex {
  x?: number | null;
  y?: number | null;
}
export interface VisionBoundingPoly {
  vertices?: VisionVertex[] | null;
}
export interface VisionSymbol {
  text?: string | null;
}
export interface VisionWord {
  symbols?: VisionSymbol[] | null;
  boundingBox?: VisionBoundingPoly | null;
}
export interface VisionParagraph {
  words?: VisionWord[] | null;
}
export interface VisionBlock {
  paragraphs?: VisionParagraph[] | null;
}
export interface VisionPage {
  blocks?: VisionBlock[] | null;
  width?: number | null;
  height?: number | null;
}

type CharClass = 'DIGIT' | 'LETTER' | 'MIXED' | 'OTHER';

function classifySymbolChar(char: string): 'DIGIT' | 'LETTER' | 'OTHER' {
  if (/^[0-9]$/.test(char)) return 'DIGIT';
  if (/^[A-Za-z]$/.test(char)) return 'LETTER';
  return 'OTHER';
}

function getWordText(word: VisionWord): string {
  return (word.symbols ?? []).map((symbol) => symbol.text ?? '').join('');
}

function classifyWord(text: string): CharClass {
  if (text.length === 0) return 'OTHER';
  const classes = new Set([...text].map(classifySymbolChar));
  if (classes.size === 1) return [...classes][0] as CharClass;
  return 'MIXED';
}

interface NormalizedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function normalizeBox(box: VisionBoundingPoly | null | undefined, pageWidth: number, pageHeight: number): NormalizedBox | null {
  const vertices = box?.vertices;
  if (!vertices || vertices.length === 0 || pageWidth <= 0 || pageHeight <= 0) return null;
  const xs = vertices.map((v) => (v.x ?? 0) / pageWidth);
  const ys = vertices.map((v) => (v.y ?? 0) / pageHeight);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function boxCenter(box: NormalizedBox | null): { x: number; y: number } | null {
  if (!box) return null;
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface WordInfo {
  paragraphKey: string;
  wordIndex: number;
  text: string;
  length: number;
  charClass: CharClass;
  box: NormalizedBox | null;
}

/** Flattens every word across every block/paragraph on every page, in document order. */
function flattenWords(pages: readonly VisionPage[]): WordInfo[] {
  const words: WordInfo[] = [];
  pages.forEach((page, pageIndex) => {
    const pageWidth = page.width ?? 0;
    const pageHeight = page.height ?? 0;
    (page.blocks ?? []).forEach((block, blockIndex) => {
      (block.paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
        const paragraphKey = `${pageIndex}:${blockIndex}:${paragraphIndex}`;
        (paragraph.words ?? []).forEach((word, wordIndex) => {
          const text = getWordText(word);
          words.push({
            paragraphKey,
            wordIndex,
            text,
            length: text.length,
            charClass: classifyWord(text),
            box: normalizeBox(word.boundingBox, pageWidth, pageHeight),
          });
        });
      });
    });
  });
  return words;
}

const ROW_Y_ALIGNMENT_MAX_SPREAD = 0.03; // normalized page-height units

interface DateRowCandidate {
  center: { x: number; y: number };
  isoDate: string;
}

/**
 * Finds every consecutive-in-paragraph word triple shaped [2-digit,
 * 2-digit, 4-digit], all DIGIT class, aligned on (approximately) the same
 * horizontal row, and builds+validates the ISO date each represents
 * (DAY MONTH YEAR — the common international passport visual-zone order).
 * A row whose digits don't form a real calendar date is dropped, never
 * corrected or guessed.
 */
function findDateRowCandidates(words: readonly WordInfo[]): DateRowCandidate[] {
  const byParagraph = new Map<string, WordInfo[]>();
  for (const word of words) {
    const list = byParagraph.get(word.paragraphKey) ?? [];
    list.push(word);
    byParagraph.set(word.paragraphKey, list);
  }
  for (const list of byParagraph.values()) {
    list.sort((a, b) => a.wordIndex - b.wordIndex);
  }

  const candidates: DateRowCandidate[] = [];
  for (const paragraphWords of byParagraph.values()) {
    for (let i = 0; i + 2 < paragraphWords.length; i++) {
      const day = paragraphWords[i]!;
      const month = paragraphWords[i + 1]!;
      const year = paragraphWords[i + 2]!;
      const shapeMatches =
        day.length === 2 &&
        day.charClass === 'DIGIT' &&
        month.length === 2 &&
        month.charClass === 'DIGIT' &&
        year.length === 4 &&
        year.charClass === 'DIGIT';
      if (!shapeMatches) continue;

      const centers = [day, month, year].map((w) => boxCenter(w.box)).filter((c): c is { x: number; y: number } => c !== null);
      if (centers.length !== 3) continue;

      const ys = centers.map((c) => c.y);
      if (Math.max(...ys) - Math.min(...ys) > ROW_Y_ALIGNMENT_MAX_SPREAD) continue;

      const isoDate = `${year.text}-${month.text}-${day.text}`;
      if (!isRealCalendarDate(isoDate)) continue;

      const xs = [day, month, year].map((w) => w.box!).flatMap((b) => [b.x0, b.x1]);
      const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: ys.reduce((sum, y) => sum + y, 0) / ys.length };
      candidates.push({ center, isoDate });
    }
  }
  return candidates;
}

const ISSUE_LABEL_PREFIXES = ['ISSUE', 'ISSUED'];

/**
 * Matches by prefix rather than exact equality — Vision can fuse trailing
 * punctuation into the same word token as the printed label (e.g. "ISSUE:",
 * "ISSUE.", "ISSUE,"), and every real label prefix already starts with
 * "ISSUE" (which is itself a prefix of "ISSUED"), so a single startsWith
 * check catches both existing exact cases plus these noise variants. This
 * can only ever match a superset of the old exact-Set check — it never
 * excludes anything that matched before.
 */
function isIssueLabelWord(text: string): boolean {
  const upper = text.toUpperCase();
  return ISSUE_LABEL_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function findIssueLabelCenters(words: readonly WordInfo[]): Array<{ x: number; y: number }> {
  return words
    .filter((w) => isIssueLabelWord(w.text))
    .map((w) => boxCenter(w.box))
    .filter((c): c is { x: number; y: number } => c !== null);
}

export function extractVisualIssueDate(pages: readonly VisionPage[], knownDates: readonly string[]): string | null {
  const words = flattenWords(pages);

  const dateRows = findDateRowCandidates(words);
  if (dateRows.length === 0) return null;

  const issueLabelCenters = findIssueLabelCenters(words);
  if (issueLabelCenters.length === 0) return null;

  let best: { isoDate: string; distance: number } | null = null;
  for (const labelCenter of issueLabelCenters) {
    for (const row of dateRows) {
      const d = distance(labelCenter, row.center);
      if (best === null || d < best.distance) best = { isoDate: row.isoDate, distance: d };
    }
  }
  if (best === null) return null;

  if (knownDates.includes(best.isoDate)) return null;

  return best.isoDate;
}
