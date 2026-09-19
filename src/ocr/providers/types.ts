import type { PassportExtractionResult } from '../passportExtractionSchema.js';

export interface OcrProvider {
  /** Stored verbatim in passport_ocr_results.provider. */
  readonly name: string;
  extract(imageBuffer: Buffer, mimeType: string): Promise<PassportExtractionResult>;
}
