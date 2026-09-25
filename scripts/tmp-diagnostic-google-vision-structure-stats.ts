/**
 * TEMPORARY ONE-OFF DIAGNOSTIC/TEST — not part of the production OCR
 * pipeline. Answers "how did Google Vision actually segment the visual-zone
 * date (e.g. as three separate words '15'/'JAN'/'2020', as one merged word
 * '15JAN2020', or corrupted by an OCR misread)" WITHOUT ever reading that
 * out as text — only via the block/paragraph/word/symbol hierarchy sizes,
 * per-word length + character class, bounding-box presence, and spatial
 * proximity between generic form-label tokens (DATE/OF/ISSUE/ISSUED — a
 * fixed, non-PII vocabulary) and 4-digit "year-shaped" tokens.
 *
 * Uses the SAME single documentTextDetection() call the existing diagnostics
 * already make (this script does not add a second Vision call, and does not
 * touch src/ocr/providers/googleVisionProvider.ts). Never logs fullText, a
 * raw word's characters, or any passport field value — only counts, enum
 * labels (DIGIT/LETTER/MIXED/OTHER), array indices, and geometric distances
 * between bounding-box centers.
 *
 * Read-only: no DB writes, no Redis, no worker/bot involvement.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

// --- Minimal structural view of Vision's response shape --------------------
// Deliberately loose/local (not importing the full proto types everywhere)
// so the pure functions below are trivially unit-testable with synthetic
// fixtures, while staying structurally compatible with the real
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
}

export type CharClass = 'DIGIT' | 'LETTER' | 'MIXED' | 'OTHER';

// Fixed, non-PII form-label vocabulary (generic passport field labels, not
// personal data) — used only to compare against internally, never logged.
const LABEL_WORDS = new Set(['DATE', 'OF', 'ISSUE', 'ISSUED']);

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

function boundingBoxCenter(box: VisionBoundingPoly | null | undefined): { x: number; y: number } | null {
  const vertices = box?.vertices;
  if (!vertices || vertices.length === 0) return null;
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface VisionStructureStatistics {
  blockCount: number;
  paragraphCount: number;
  wordCount: number;
  symbolCount: number;
  wordLengths: number[];
  charClassCounts: Record<CharClass, number>;
  boundingBoxPresentCount: number;
  boundingBoxMissingCount: number;
  labelTokenCount: number;
  labelTokenInfos: Array<{ length: number; charClass: CharClass }>;
  fourDigitYearLikeTokenCount: number;
  fourDigitYearLikeTokenInfos: Array<{
    blockIndex: number;
    paragraphIndex: number;
    wordIndexInParagraph: number;
    length: number;
    charClass: CharClass;
  }>;
  /** Pixel distance from each label token to its nearest year-like token (bounding-box centers only). */
  labelToNearestYearLikeDistances: number[];
}

/**
 * Walks the block/paragraph/word/symbol hierarchy once and reports only
 * structural counts, per-word length + character class, bounding-box
 * presence, and label<->year-like-token spatial proximity. Reads each
 * word's text only to compare against the fixed LABEL_WORDS vocabulary or
 * to classify its characters — the text itself is never returned or logged.
 */
export function computeVisionStructureStatistics(pages: readonly VisionPage[]): VisionStructureStatistics {
  let blockCount = 0;
  let paragraphCount = 0;
  let wordCount = 0;
  let symbolCount = 0;
  const wordLengths: number[] = [];
  const charClassCounts: Record<CharClass, number> = { DIGIT: 0, LETTER: 0, MIXED: 0, OTHER: 0 };
  let boundingBoxPresentCount = 0;
  let boundingBoxMissingCount = 0;
  const labelTokenInfos: Array<{ length: number; charClass: CharClass; center: { x: number; y: number } | null }> = [];
  const yearLikeTokenInfos: Array<{
    blockIndex: number;
    paragraphIndex: number;
    wordIndexInParagraph: number;
    length: number;
    charClass: CharClass;
    center: { x: number; y: number } | null;
  }> = [];

  for (const page of pages) {
    const blocks = page.blocks ?? [];
    blockCount += blocks.length;
    blocks.forEach((block, blockIndex) => {
      const paragraphs = block.paragraphs ?? [];
      paragraphCount += paragraphs.length;
      paragraphs.forEach((paragraph, paragraphIndex) => {
        const words = paragraph.words ?? [];
        wordCount += words.length;
        words.forEach((word, wordIndexInParagraph) => {
          const symbols = word.symbols ?? [];
          symbolCount += symbols.length;
          const length = symbols.length;
          const charClass = classifyWord(word);
          wordLengths.push(length);
          charClassCounts[charClass] += 1;

          const center = boundingBoxCenter(word.boundingBox);
          if (center !== null) boundingBoxPresentCount += 1;
          else boundingBoxMissingCount += 1;

          const text = getWordText(word).toUpperCase();
          if (LABEL_WORDS.has(text)) {
            labelTokenInfos.push({ length, charClass, center });
          }
          if (length === 4 && charClass === 'DIGIT') {
            yearLikeTokenInfos.push({ blockIndex, paragraphIndex, wordIndexInParagraph, length, charClass, center });
          }
        });
      });
    });
  }

  const labelToNearestYearLikeDistances = labelTokenInfos
    .filter((label) => label.center !== null)
    .map((label) => {
      const distances = yearLikeTokenInfos
        .filter((year) => year.center !== null)
        .map((year) => distance(label.center as { x: number; y: number }, year.center as { x: number; y: number }));
      return distances.length > 0 ? Math.min(...distances) : null;
    })
    .filter((value): value is number => value !== null);

  return {
    blockCount,
    paragraphCount,
    wordCount,
    symbolCount,
    wordLengths,
    charClassCounts,
    boundingBoxPresentCount,
    boundingBoxMissingCount,
    labelTokenCount: labelTokenInfos.length,
    labelTokenInfos: labelTokenInfos.map(({ length, charClass }) => ({ length, charClass })),
    fourDigitYearLikeTokenCount: yearLikeTokenInfos.length,
    fourDigitYearLikeTokenInfos: yearLikeTokenInfos.map(
      ({ blockIndex, paragraphIndex, wordIndexInParagraph, length, charClass }) => ({
        blockIndex,
        paragraphIndex,
        wordIndexInParagraph,
        length,
        charClass,
      }),
    ),
    labelToNearestYearLikeDistances,
  };
}

export function formatVisionStructureStatistics(stats: VisionStructureStatistics): string {
  return [
    `blockCount=${stats.blockCount} paragraphCount=${stats.paragraphCount} wordCount=${stats.wordCount} symbolCount=${stats.symbolCount}`,
    `wordLengths=[${stats.wordLengths.join(',')}]`,
    `charClassCounts=${JSON.stringify(stats.charClassCounts)}`,
    `boundingBoxPresentCount=${stats.boundingBoxPresentCount} boundingBoxMissingCount=${stats.boundingBoxMissingCount}`,
    `labelTokenCount=${stats.labelTokenCount} labelTokenInfos=${JSON.stringify(stats.labelTokenInfos)}`,
    `fourDigitYearLikeTokenCount=${stats.fourDigitYearLikeTokenCount} fourDigitYearLikeTokenInfos=${JSON.stringify(stats.fourDigitYearLikeTokenInfos)}`,
    `labelToNearestYearLikeDistances=[${stats.labelToNearestYearLikeDistances.map((d) => d.toFixed(1)).join(',')}]`,
  ].join('\n');
}

let realVisionClient: ImageAnnotatorClient | null = null;
function getRealVisionClient(): ImageAnnotatorClient {
  if (!realVisionClient) {
    realVisionClient = new ImageAnnotatorClient();
  }
  return realVisionClient;
}

/** Same minimal DOCUMENT_TEXT_DETECTION call every other diagnostic here makes — exactly one per message. */
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
  console.log(`\n[vision-structure-stats] ===== telegram_message_num=${telegramMessageNum} =====`);

  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    `SELECT telegram_photo_file_id FROM telegram_messages WHERE telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [telegramMessageNum],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.log('[vision-structure-stats] no telegram_messages row found for this number');
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);

  let textAnnotation: protos.google.cloud.vision.v1.ITextAnnotation | null | undefined;
  try {
    textAnnotation = await detectTextAnnotation(buffer);
  } catch {
    console.log('[vision-structure-stats] visionSuccess=false (Vision API call failed)');
    return;
  }

  const pages = textAnnotation?.pages;
  if (!pages || pages.length === 0) {
    console.log('[vision-structure-stats] visionSuccess=true pageCount=0 (no structural data returned)');
    return;
  }
  console.log(`[vision-structure-stats] visionSuccess=true pageCount=${pages.length}`);

  const stats = computeVisionStructureStatistics(pages as VisionPage[]);
  console.log(formatVisionStructureStatistics(stats));
}

async function main(): Promise<void> {
  const telegramMessageNums = process.argv.slice(2);
  if (telegramMessageNums.length === 0) {
    console.error(
      'Usage: tsx scripts/tmp-diagnostic-google-vision-structure-stats.ts <telegram_messages.telegram_message_id> [...]',
    );
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-structure-stats.ts')) {
  main().catch((error) => {
    console.error('[vision-structure-stats] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
