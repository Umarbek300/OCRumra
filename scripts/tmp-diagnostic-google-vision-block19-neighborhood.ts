/**
 * TEMPORARY ONE-OFF DIAGNOSTIC/TEST — not part of the production OCR
 * pipeline. Follow-up to tmp-diagnostic-google-vision-structure-stats.ts:
 * that diagnostic already showed real messages 270 and 271 both contain a
 * 4-digit "year-shaped" word close to a DATE/OF/ISSUE label — so Vision
 * itself is finding the date. This diagnostic zooms in on exactly where
 * that happens (blockIndex=19 in both real passports, per that earlier
 * run) to see, word by word, whether Vision segments the issue date as
 * separate DD / MON / YYYY words, one merged word, or something else —
 * information the flat fullText string alone doesn't preserve as clearly
 * as the structured word list does.
 *
 * ONLY intended to be run for telegram_message_id 270 and 271. Makes
 * exactly ONE documentTextDetection() call per message (no second OCR
 * call, no Tesseract). Never touches
 * src/ocr/providers/googleVisionProvider.ts or any other production file.
 *
 * PII-safe: never logs raw OCR text, fullText, passport number, name, or
 * a complete date value — only blockIndex/paragraphIndex/wordIndex,
 * per-word length, character class (DIGIT/LETTER/MIXED/OTHER), and
 * normalized (0..1) bounding-box coordinates.
 *
 * Read-only: no DB writes, no Redis, no worker/bot involvement.
 */
import { ImageAnnotatorClient, protos } from '@google-cloud/vision';
import { pool } from '../src/db/pool.js';
import { downloadTelegramPhoto } from '../src/telegram/downloadTelegramPhoto.js';

const ALLOWED_TELEGRAM_MESSAGE_NUMS = new Set(['270', '271']);
const TARGET_BLOCK_INDEX = 19;
const NEIGHBOR_CONTEXT_SIZE = 3;

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

export interface WordDetail {
  blockIndex: number;
  paragraphIndex: number;
  wordIndex: number;
  length: number;
  charClass: CharClass;
  normalizedBox: NormalizedBox | null;
}

/**
 * Flattens every word inside ONE target block (in document order: paragraph
 * then word-within-paragraph) into structural-only records. Reads each
 * word's symbols only to compute length/charClass — never returns or logs
 * the characters themselves.
 */
export function extractBlockWordDetails(
  pages: readonly VisionPage[],
  targetBlockIndex: number,
): WordDetail[] {
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

export interface YearTokenNeighborhood {
  yearToken: WordDetail;
  precedingWords: WordDetail[];
  followingWords: WordDetail[];
}

/**
 * For every 4-digit DIGIT-class word in `words`, captures up to
 * `contextSize` words immediately before and after it WITHIN THE SAME
 * PARAGRAPH (by wordIndex order) — this is what reveals whether Vision
 * segmented "15" "JAN" "2020" as neighbors of the year token, a single
 * merged word instead, or something unrelated sitting next to it.
 */
export function computeYearTokenNeighborhoods(
  words: readonly WordDetail[],
  contextSize: number = NEIGHBOR_CONTEXT_SIZE,
): YearTokenNeighborhood[] {
  const byParagraph = new Map<number, WordDetail[]>();
  for (const word of words) {
    const list = byParagraph.get(word.paragraphIndex) ?? [];
    list.push(word);
    byParagraph.set(word.paragraphIndex, list);
  }
  for (const list of byParagraph.values()) {
    list.sort((a, b) => a.wordIndex - b.wordIndex);
  }

  const neighborhoods: YearTokenNeighborhood[] = [];
  for (const word of words) {
    if (word.length !== 4 || word.charClass !== 'DIGIT') continue;
    const paragraphWords = byParagraph.get(word.paragraphIndex) ?? [];
    const selfPos = paragraphWords.findIndex((w) => w.wordIndex === word.wordIndex);
    const precedingWords = paragraphWords.slice(Math.max(0, selfPos - contextSize), selfPos);
    const followingWords = paragraphWords.slice(selfPos + 1, selfPos + 1 + contextSize);
    neighborhoods.push({ yearToken: word, precedingWords, followingWords });
  }
  return neighborhoods;
}

function formatWordDetail(w: WordDetail): string {
  const box = w.normalizedBox
    ? `[${w.normalizedBox.x0.toFixed(3)},${w.normalizedBox.y0.toFixed(3)},${w.normalizedBox.x1.toFixed(3)},${w.normalizedBox.y1.toFixed(3)}]`
    : 'null';
  return `(b=${w.blockIndex},p=${w.paragraphIndex},w=${w.wordIndex},len=${w.length},class=${w.charClass},box=${box})`;
}

export function formatBlockNeighborhoodReport(
  words: readonly WordDetail[],
  neighborhoods: readonly YearTokenNeighborhood[],
): string {
  const lines: string[] = [];
  lines.push(`blockIndex=${TARGET_BLOCK_INDEX} totalWordsInBlock=${words.length}`);
  lines.push('all words in block, in order:');
  for (const w of words) lines.push(`  ${formatWordDetail(w)}`);
  lines.push(`yearTokenNeighborhoodCount=${neighborhoods.length}`);
  neighborhoods.forEach((n, i) => {
    lines.push(`neighborhood[${i}]:`);
    lines.push(`  yearToken=${formatWordDetail(n.yearToken)}`);
    lines.push(`  preceding=[${n.precedingWords.map(formatWordDetail).join(', ')}]`);
    lines.push(`  following=[${n.followingWords.map(formatWordDetail).join(', ')}]`);
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
  console.log(`\n[block19-neighborhood] ===== telegram_message_num=${telegramMessageNum} =====`);

  const queryResult = await pool.query<{ telegram_photo_file_id: string }>(
    `SELECT telegram_photo_file_id FROM telegram_messages WHERE telegram_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [telegramMessageNum],
  );
  const row = queryResult.rows[0];
  if (!row) {
    console.log('[block19-neighborhood] no telegram_messages row found for this number');
    return;
  }

  const { buffer } = await downloadTelegramPhoto(row.telegram_photo_file_id);

  let textAnnotation: protos.google.cloud.vision.v1.ITextAnnotation | null | undefined;
  try {
    textAnnotation = await detectTextAnnotation(buffer);
  } catch {
    console.log('[block19-neighborhood] visionSuccess=false (Vision API call failed)');
    return;
  }

  const pages = textAnnotation?.pages;
  if (!pages || pages.length === 0) {
    console.log('[block19-neighborhood] visionSuccess=true pageCount=0 (no structural data returned)');
    return;
  }
  const blockCount = (pages[0]?.blocks ?? []).length;
  console.log(`[block19-neighborhood] visionSuccess=true pageCount=${pages.length} blockCountOnFirstPage=${blockCount}`);

  const words = extractBlockWordDetails(pages as VisionPage[], TARGET_BLOCK_INDEX);
  const neighborhoods = computeYearTokenNeighborhoods(words);
  console.log(formatBlockNeighborhoodReport(words, neighborhoods));
}

async function main(): Promise<void> {
  const telegramMessageNums = process.argv.slice(2);
  if (telegramMessageNums.length === 0) {
    console.error('Usage: tsx scripts/tmp-diagnostic-google-vision-block19-neighborhood.ts <270|271> [...]');
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

if (process.argv[1] && process.argv[1].endsWith('tmp-diagnostic-google-vision-block19-neighborhood.ts')) {
  main().catch((error) => {
    console.error('[block19-neighborhood] failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
