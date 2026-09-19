import { extractPassportData } from '../extractPassportData.js';
import type { OcrProvider } from './types.js';

/** Unchanged behavior — the original, only, provider before this abstraction existed. */
export const anthropicProvider: OcrProvider = {
  name: 'anthropic',
  extract: (imageBuffer, mimeType) => extractPassportData(imageBuffer, mimeType),
};
