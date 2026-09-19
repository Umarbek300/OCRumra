import { extractMrzLines } from '../mrz/extractMrzLines.js';
import { locateMrzRegion } from '../mrz/locateMrzRegion.js';
import { buildUnreadableMrzResult, mapMrzToExtractionResult } from '../mrz/mapMrzToExtractionResult.js';
import { parseAndValidateMrz } from '../mrz/parseAndValidateMrz.js';
import { runTesseractOcr } from '../mrz/runTesseractOcr.js';
import type { PassportExtractionResult } from '../passportExtractionSchema.js';
import type { OcrProvider } from './types.js';

export interface LocalProviderDependencies {
  locateMrzRegion: typeof locateMrzRegion;
  runTesseractOcr: typeof runTesseractOcr;
}

const defaultDependencies: LocalProviderDependencies = {
  locateMrzRegion,
  runTesseractOcr,
};

/**
 * Free, on-server passport MRZ extraction: crop the MRZ band -> OCR it with
 * Tesseract -> parse + validate check digits with the `mrz` package -> map
 * onto the same result shape the Anthropic provider produces. Never calls
 * any external API — everything here runs as a local process/library on
 * this machine. Never guesses: an unreadable/invalid MRZ produces an
 * all-null, low-confidence result instead of throwing, mirroring how the
 * Anthropic path behaves on a genuinely bad photo.
 */
export function createLocalProvider(deps: LocalProviderDependencies = defaultDependencies): OcrProvider {
  return {
    name: 'local',
    async extract(imageBuffer: Buffer): Promise<PassportExtractionResult> {
      const mrzRegion = await deps.locateMrzRegion(imageBuffer);
      const rawOcrText = await deps.runTesseractOcr(mrzRegion);
      const mrzLines = extractMrzLines(rawOcrText);

      const parsed = parseAndValidateMrz(mrzLines);
      if (!parsed) {
        return buildUnreadableMrzResult(mrzLines);
      }

      return mapMrzToExtractionResult(parsed, mrzLines);
    },
  };
}

export const localProvider: OcrProvider = createLocalProvider();
