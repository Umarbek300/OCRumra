import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';

let client: Anthropic | null = null;

/**
 * Lazily constructs the Anthropic client on first real use. This is the
 * ONE place ANTHROPIC_API_KEY's absence becomes a hard error — admin,
 * migrate, health, and bot scripts never call this and are unaffected.
 */
export function getAnthropicClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured; passport OCR cannot run without it');
  }
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}
