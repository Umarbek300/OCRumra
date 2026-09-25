import type { Env } from '../../config/env.schema.js';
import { anthropicProvider } from './anthropicProvider.js';
import { compareProvider } from './compareProvider.js';
import { googleVisionProvider } from './googleVisionProvider.js';
import { localProvider } from './localProvider.js';
import type { OcrProvider } from './types.js';

export function selectProvider(ocrProvider: Env['OCR_PROVIDER']): OcrProvider {
  switch (ocrProvider) {
    case 'local':
      return localProvider;
    case 'compare':
      return compareProvider;
    case 'anthropic':
      return anthropicProvider;
    case 'google-vision':
      return googleVisionProvider;
  }
}

export type { OcrProvider } from './types.js';
