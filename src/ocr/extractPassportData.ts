import Anthropic, { BadRequestError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../config/env.js';
import { getAnthropicClient } from './anthropicClient.js';
import {
  ClaudePassportResponseSchema,
  computeOverallConfidence,
  type PassportExtractionResult,
} from './passportExtractionSchema.js';
import { PASSPORT_EXTRACTION_SYSTEM_PROMPT, buildPassportExtractionUserPrompt } from './prompt.js';

const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const MAX_OUTPUT_TOKENS = 4096;

/**
 * The dedicated Claude Vision passport-extraction interface. Takes the raw
 * image bytes (never touches Redis or disk) and returns a validated,
 * normalized structured result — never arbitrary prose.
 *
 * `client` is injectable so tests can supply a mock and never hit the real
 * Anthropic API; production callers omit it and get the lazy shared client
 * (which itself enforces ANTHROPIC_API_KEY is set).
 */
export async function extractPassportData(
  imageBuffer: Buffer,
  mimeType: string,
  client?: Anthropic,
): Promise<PassportExtractionResult> {
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image mime type for passport OCR: ${mimeType}`);
  }

  const anthropicClient = client ?? getAnthropicClient();
  const model = env.ANTHROPIC_MODEL;

  let response;
  try {
    response = await anthropicClient.messages.parse({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: PASSPORT_EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as SupportedImageMimeType,
                data: imageBuffer.toString('base64'),
              },
            },
            { type: 'text', text: buildPassportExtractionUserPrompt() },
          ],
        },
      ],
      output_config: {
        format: zodOutputFormat(ClaudePassportResponseSchema),
      },
    });
  } catch (error) {
    throw new Error(`Claude Vision request failed: ${describeAnthropicError(error)}`);
  }

  if (!response.parsed_output) {
    throw new Error('Claude returned a response that did not match the expected passport extraction schema');
  }

  const validated = ClaudePassportResponseSchema.safeParse(response.parsed_output);
  if (!validated.success) {
    throw new Error('Claude response failed passport extraction validation');
  }

  const fields = validated.data;
  const overallConfidence = computeOverallConfidence(fields);

  return { ...fields, overallConfidence, model };
}

/**
 * Deliberately returns only a short category, never the raw request/response
 * bodies — those can carry sensitive document content. The one exception is
 * BadRequestError: Anthropic's 400 body only ever describes a structural
 * problem with the request itself (bad parameter, unsupported media type,
 * payload too large, etc.) — it never echoes back message content — so a
 * bounded excerpt of it is safe and needed to diagnose 400s in production.
 */
function describeAnthropicError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'authentication failed (check ANTHROPIC_API_KEY)';
  if (error instanceof Anthropic.PermissionDeniedError) return 'permission denied';
  if (error instanceof Anthropic.NotFoundError) return 'model or resource not found';
  if (error instanceof Anthropic.RateLimitError) return 'rate limited';
  if (error instanceof Anthropic.BadRequestError) return `bad request: ${extractBadRequestDetail(error)}`;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'request timed out';
  if (error instanceof Anthropic.APIConnectionError) return 'connection error';
  if (error instanceof Anthropic.APIError) return `API error (status ${error.status ?? 'unknown'})`;
  return 'unknown error';
}

const MAX_BAD_REQUEST_DETAIL_LENGTH = 200;

function extractBadRequestDetail(error: BadRequestError): string {
  const body = error.error;
  const message =
    body && typeof body === 'object' && 'message' in body && typeof (body as { message: unknown }).message === 'string'
      ? (body as { message: string }).message
      : undefined;
  if (!message) return 'no further detail from Claude';
  return message.length > MAX_BAD_REQUEST_DETAIL_LENGTH ? `${message.slice(0, MAX_BAD_REQUEST_DETAIL_LENGTH)}…` : message;
}
