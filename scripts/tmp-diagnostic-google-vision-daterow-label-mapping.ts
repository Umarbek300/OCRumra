/**
 * TEMPORARY ONE-OFF DIAGNOSTIC/TEST — not part of the production OCR
 * pipeline. Follow-up to tmp-diagnostic-google-vision-block19-neighborhood.ts:
 * that diagnostic showed real messages 270 and 271 both segment their
 * visual-zone dates as three SEPARATE all-digit words (DD, DD, YYYY) in
 * block 19, well-aligned on the same horizontal row — not as a merged
 * "DD/MON/YYYY" token, and not with a textual month name. That is very
 * likely why extractDateCandidates() (which requires a punctuation
 * separator like '.', '/', '-' between digit groups) finds nothing: three
 * space-joined words in flattened text have no such separator.
 *
 * This diagnostic does NOT fix that — it only answers the next open
 * question before any production change: block 19 has multiple DD-DD-YYYY
 * rows (birth date, issue date, expiry date can all appear there), so
 * which row is which field? It finds every such row by bounding-box shape
 * and horizontal alignment, and measures each row's spatial distance to
 * the nearest BIRTH/ISSUE/EXPIRY-category label word, all via structural
 * metadata only.
 *
 * ONLY intended to be run for telegram_message_id 270 and 271. Makes
 * exactly ONE documentTextDetection() call per message (no second OCR
 * call, no Tesseract). Never touches
 * src/ocr/providers/googleVisionProvider.ts, src/ocr/visual/*, or any
 * other production file.
 *
 * PII-safe: never logs raw OCR text, fullText, passport number, name, or
 * any complete date value — only blockIndex/paragraphIndex/wordIndex,
 * per-word length, character class (DIGIT/LETTER/MIXED/OTHER), normalized
 * (0..1) bounding-box coordinates, and geometric distances.
 *
 * Read-only: no DB writes, no Redis, no worker/bot involvement.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const ALLOWED_TELEGRAM_MESSAGE_NUMS = new Set(['270', '271']);
const TARGET_BLOCK_INDEX = 19;

// --- Minimal structural view of Vision's response shape --------------------
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

export type CharClass = 'DIGIT' | 'LETTER' | 'MIXED' | 'OTHER';

function classifySymbolChar(char: string): 'DIGIT' | 'LETTER' | 'OTHER' {
  if (/^[0-9]$/.test(char)) return 'DIGIT';
  if (/^[A-Za-z]$/.test(char)) return 'LETTER';
  return 'OTHER';
}

function classifyWord(word: VisionWord): CharClass {
  const symbols = word.symbols ?? [];
  if (symbols.length === 0) return 'OTHER';
  const classes = new Set(symbols.map((symbol) => classifySymbolChar(symbol.text ?? '')));
  if (classes.size === 1) return [...classes][0] as CharClass;
  return 'MIXED';
}

function getWordText(word: VisionWord): string {
  return (word.symbols ?? []).map((symbol) => symbol.text ?? '').join('');
}

export interface NormalizedBox {
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

export interface WordDetail {
  blockIndex: number;
  paragraphIndex: number;
  wordIndex: number;
  length: number;
  charClass: CharClass;
  normalizedBox: NormalizedBox | null;
}

/** Reads each word's symbols only to compute length/charClass — never returns the characters themselves. */
export function extractBlockWordDetails(pages: readonly VisionPage[], targetBlockIndex: number): WordDetail[] {
  const details: WordDetail[] = [];
  for (const page of pages) {
    const pageWidth = page.width ?? 0;
    const pageHeight = page.height ?? 0;
    const blocks = page.blocks ?? [];
    const block = blocks[targetBlockIndex];
    if (!block) continue;
    const paragraphs = block.paragraphs ?? [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const words = paragraph.words ?? [];
      words.forEach((word, wordIndex) => {
        const symbols = word.symbols ?? [];
        details.push({
          blockIndex: targetBlockIndex,
          paragraphIndex,
          wordIndex,
          length: symbols.length,
          charClass: classifyWord(word),
          normalizedBox: normalizeBox(word.boundingBox, pageWidth, pageHeight),
        });
      });
    });
  }
  return details;
}

// Only needed to compare against a fixed, non-PII label vocabulary and
// classify which passport field it belongs to — the text itself is never
// returned or logged.
export type LabelCategory = 'BIRTH' | 'ISSUE' | 'EXPIRY' | 'OTHER_LABEL';
const LABEL_CATEGORY_BY_WORD: Record<string, LabelCategory> = {
  BIRTH: 'BIRTH',
  BORN: 'BIRTH',
  ISSUE: 'ISSUE',
  ISSUED: 'ISSUE',
  EXPIRY: 'EXPIRY',
  EXPIRATION: 'EXPIRY',
  EXPIRES: 'EXPIRY',
  VALID: 'EXPIRY',
  DATE: 'OTHER_LABEL',
  OF: 'OTHER_LABEL',
};

export interface LabelWordDetail extends WordDetail {
  category: LabelCategory;
}

/**
 * Like extractBlockWordDetails, but additionally reads each word's text
 * (never returned) to compare against the fixed LABEL_CATEGORY_BY_WORD
 * vocabulary, keeping only words that match a known passport-field label.
 */
export function extractLabelWordsFromPages(pages: readonly VisionPage[], targetBlockIndex: number): LabelWordDetail[] {
  const details: LabelWordDetail[] = [];
  for (const page of pages) {
    const pageWidth = page.width ?? 0;
    const pageHeight = page.height ?? 0;
    const blocks = page.blocks ?? [];
    const block = blocks[targetBlockIndex];
    if (!block) continue;
    const paragraphs = block.paragraphs ?? [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const words = paragraph.words ?? [];
      words.forEach((word, wordIndex) => {
        const text = getWordText(word).toUpperCase();
        const category = LABEL_CATEGORY_BY_WORD[text];
        if (!category) return;
        const symbols = word.symbols ?? [];
        details.push({
          blockIndex: targetBlockIndex,
          paragraphIndex,
          wordIndex,
          length: symbols.length,
          charClass: classifyWord(word),
          normalizedBox: normalizeBox(word.boundingBox, pageWidth, pageHeight),
          category,
        });
      });
    });
  }
  return details;
}

export interface DateRow {
  paragraphIndex: number;
  words: [WordDetail, WordDetail, WordDetail];
  rowYCenter: number;
  yAlignmentSpread: number;
}

const ROW_Y_ALIGNMENT_MAX_SPREAD = 0.03; // normalized page-height units

/**
 * Finds every consecutive-in-paragraph triple shaped [2-digit, 2-digit,
 * 4-digit], all DIGIT class, whose bounding boxes sit on (approximately)
 * the same horizontal row — the structural fingerprint of a "DD DD YYYY"
 * visual date Vision segmented as three separate words.
 */
export function findDateRows(words: readonly WordDetail[]): DateRow[] {
  const byParagraph = new Map<number, WordDetail[]>();
  for (const word of words) {
    const list = byParagraph.get(word.paragraphIndex) ?? [];
    list.push(word);
    byParagraph.set(word.paragraphIndex, list);
  }
  for (const list of byParagraph.values()) {
    list.sort((a, b) => a.wordIndex - b.wordIndex);
  }

  const rows: DateRow[] = [];
  for (const [paragraphIndex, paragraphWords] of byParagraph) {
    for (let i = 0; i + 2 < paragraphWords.length; i++) {
      const a = paragraphWords[i]!;
      const b = paragraphWords[i + 1]!;
      const c = paragraphWords[i + 2]!;
      const shapeMatches =
        a.length === 2 && a.charClass === 'DIGIT' && b.length === 2 && b.charClass === 'DIGIT' && c.length === 4 && c.charClass === 'DIGIT';
      if (!shapeMatches) continue;

      const centers = [a, b, c].map((w) => boxCenter(w.normalizedBox)).filter((v): v is { x: number; y: number } => v !== null);
      if (centers.length !== 3) continue;

      const ys = centers.map((center) => center.y);
      const yAlignmentSpread = Math.max(...ys) - Math.min(...ys);
      if (yAlignmentSpread > ROW_Y_ALIGNMENT_MAX_SPREAD) continue;

      const rowYCenter = ys.reduce((sum, y) => sum + y, 0) / ys.length;
      rows.push({ paragraphIndex, words: [a, b, c], rowYCenter, yAlignmentSpread });
    }
  }
  return rows;
}

function rowCenter(row: DateRow): { x: number; y: number } | null {
  const boxes = row.words.map((w) => w.normalizedBox).filter((b): b is NormalizedBox => b !== null);
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x0));
  const x1 = Math.max(...boxes.map((b) => b.x1));
  return { x: (x0 + x1) / 2, y: row.rowYCenter };
}

export interface NearestRowResult {
  rowIndex: number;
  distance: number;
}

/** For each label category, finds the DateRow whose center is closest to any label word of that category. */
export function computeNearestRowPerCategory(
  rows: readonly DateRow[],
  labelWords: readonly LabelWordDetail[],
): Record<LabelCategory, NearestRowResult | null> {
  const result: Record<LabelCategory, NearestRowResult | null> = {
    BIRTH: null,
    ISSUE: null,
    EXPIRY: null,
    OTHER_LABEL: null,
  };
  const categories: LabelCategory[] = ['BIRTH', 'ISSUE', 'EXPIRY', 'OTHER_LABEL'];

  for (const category of categories) {
    const labelsInCategory = labelWords.filter((w) => w.category === category);
    let best: NearestRowResult | null = null;
    for (const label of labelsInCategory) {
      const labelCenter = boxCenter(label.normalizedBox);
      if (!labelCenter) continue;
      rows.forEach((row, rowIndex) => {
        const center = rowCenter(row);
        if (!center) return;
        const d = distance(labelCenter, center);
        if (best === null || d < best.distance) best = { rowIndex, distance: d };
      });
    }
    result[category] = best;
  }
  return result;
}

function formatWordDetail(w: WordDetail): string {
  const box = w.normalizedBox
    ? `[${w.normalizedBox.x0.toFixed(3)},${w.normalizedBox.y0.toFixed(3)},${w.normalizedBox.x1.toFixed(3)},${w.normalizedBox.y1.toFixed(3)}]`
    : 'null';
  return `(p=${w.paragraphIndex},w=${w.wordIndex},len=${w.length},class=${w.charClass},box=${box})`;
}

export function formatDateRowLabelReport(
  rows: readonly DateRow[],
  labelWords: readonly LabelWordDetail[],
  nearestPerCategory: Record<LabelCategory, NearestRowResult | null>,
): string {
  const lines: string[] = [];
  lines.push(`blockIndex=${TARGET_BLOCK_INDEX} dateRowCount=${rows.length}`);
  rows.forEach((row, i) => {
    lines.push(
      `dateRow[${i}]: paragraphIndex=${row.paragraphIndex} rowYCenter=${row.rowYCenter.toFixed(3)} yAlignmentSpread=${row.yAlignmentSpread.toFixed(4)}`,
    );
    lines.push(`  words=[${row.words.map(formatWordDetail).join(', ')}]`);
  });

  const labelCountByCategory: Record<LabelCategory, number> = { BIRTH: 0, ISSUE: 0, EXPIRY: 0, OTHER_LABEL: 0 };
  for (const w of labelWords) labelCountByCategory[w.category] += 1;
  lines.push(`labelWordCountByCategory=${JSON.stringify(labelCountByCategory)}`);

  lines.push('nearestRowPerCategory:');
  (['BIRTH', 'ISSUE', 'EXPIRY', 'OTHER_LABEL'] as const).forEach((category) => {
    const nearest = nearestPerCategory[category];
    lines.push(`  ${category}: ${nearest ? `rowIndex=${nearest.rowIndex} distance=${nearest.distance.toFixed(4)}` : 'none found'}`);
  });

  return lines.join('\n');
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/** Same single DOCUMENT_TEXT_DETECTION call every other diagnostic here makes — exactly one per message. */
async function detectTextAnnotation(
  imageBuffer: Buffer,
): Promise<protos.google.cloud.vision.v1.ITextAnnotation | null | undefined> {
  const client = getRealVisionClient();
  const [response]: [protos.google.cloud.vision.v1.IAnnotateImageResponse] =
    await client.documentTextDetection(imageBuffer);
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  return response.fullTextAnnotation;
}

async function runForTelegramMessageNumber(telegramMessageNum: string): Promise<void> {
  console.log(`\n[daterow-label-mapping] ===== telegram_message_num=${telegramMessageNum} =====`);

  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    `SELECT telegram_photo_file_id FROM telegram_messages WHERE telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [telegramMessageNum],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.log('[daterow-label-mapping] no telegram_messages row found for this number');
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);

  let textAnnotation: protos.google.cloud.vision.v1.ITextAnnotation | null | undefined;
  try {
    textAnnotation = await detectTextAnnotation(buffer);
  } catch {
    console.log('[daterow-label-mapping] visionSuccess=false (Vision API call failed)');
    return;
  }

  const pages = textAnnotation?.pages;
  if (!pages || pages.length === 0) {
    console.log('[daterow-label-mapping] visionSuccess=true pageCount=0 (no structural data returned)');
    return;
  }
  console.log(`[daterow-label-mapping] visionSuccess=true pageCount=${pages.length}`);

  const visionPages = pages as VisionPage[];
  const words = extractBlockWordDetails(visionPages, TARGET_BLOCK_INDEX);
  const labelWords = extractLabelWordsFromPages(visionPages, TARGET_BLOCK_INDEX);
  const rows = findDateRows(words);
  const nearestPerCategory = computeNearestRowPerCategory(rows, labelWords);

  console.log(formatDateRowLabelReport(rows, labelWords, nearestPerCategory));
}

async function main(): Promise<void> {
  const telegramMessageNums = process.argv.slice(2);
  if (telegramMessageNums.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-google-vision-daterow-label-mapping.ts <270|271> [...]');
    process.exitCode = 1;
    return;
  }
  const invalid = telegramMessageNums.filter((num) => !ALLOWED_TELEGRAM_MESSAGE_NUMS.has(num));
  if (invalid.length > 0) {
    console.error(`This diagnostic is scoped to messages 270/271 only; rejected: ${invalid.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  try {
    for (const num of telegramMessageNums) {
      await runForTelegramMessageNumber(num);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-daterow-label-mapping.ts')) {
  main().catch((error) => {
    console.error('[daterow-label-mapping] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
