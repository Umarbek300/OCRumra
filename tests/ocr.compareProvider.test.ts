import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompareProvider, type CompareProviderDependencies } from '../src/ocr/providers/compareProvider.js';
import type { OcrProvider } from '../src/ocr/providers/types.js';
import type { PassportExtractionResult } from '../src/ocr/passportExtractionSchema.js';

function field(value: string | null = null, confidence: 'high' | 'medium' | 'low' | null = null) {
  return { value, confidence };
}

function genderField(value: 'male' | 'female' | 'unspecified' | null = null, confidence: 'high' | 'medium' | 'low' | null = null) {
  return { value, confidence };
}

function sampleResult(overrides: Partial<PassportExtractionResult> = {}): PassportExtractionResult {
  return {
    firstName: field('Anna'),
    middleName: field(),
    surname: field('Eriksson'),
    passportNumber: field('L898902C3'),
    dateOfBirth: field('1974-08-12'),
    passportIssueDate: field(),
    passportExpiryDate: field('2012-04-15'),
    gender: genderField('female'),
    nationality: field('UTO'),
    placeOfBirth: field(),
    issuingAuthority: field(),
    mrz: field(),
    overallConfidence: 'high',
    model: 'test-model',
    ...overrides,
  };
}

function buildDeps(overrides: Partial<CompareProviderDependencies> = {}): {
  deps: CompareProviderDependencies;
  calls: { local: number; anthropic: number };
} {
  const calls = { local: 0, anthropic: 0 };
  const localMock: OcrProvider = {
    name: 'local',
    extract: async () => {
      calls.local += 1;
      return sampleResult({ model: 'tesseract-mrz-local' });
    },
  };
  const anthropicMock: OcrProvider = {
    name: 'anthropic',
    extract: async () => {
      calls.anthropic += 1;
      return sampleResult({ model: 'claude-opus-5', firstName: field('Different') });
    },
  };
  const deps: CompareProviderDependencies = {
    local: localMock,
    anthropic: anthropicMock,
    compareWithAnthropic: false,
    ...overrides,
  };
  return { deps, calls };
}

test('compare provider is named "local" (local result is authoritative)', () => {
  const { deps } = buildDeps();
  assert.equal(createCompareProvider(deps).name, 'local');
});

test('compare provider never calls Anthropic unless compareWithAnthropic is explicitly true', async () => {
  const { deps, calls } = buildDeps({ compareWithAnthropic: false });
  const provider = createCompareProvider(deps);

  const result = await provider.extract(Buffer.from('x'), 'image/jpeg');

  assert.equal(calls.local, 1);
  assert.equal(calls.anthropic, 0, 'must never spend Anthropic credits by default');
  assert.equal(result.model, 'tesseract-mrz-local', 'local result is what gets returned');
});

test('compare provider calls Anthropic and still returns the local result as authoritative when enabled', async () => {
  const { deps, calls } = buildDeps({ compareWithAnthropic: true });
  const provider = createCompareProvider(deps);

  const result = await provider.extract(Buffer.from('x'), 'image/jpeg');

  assert.equal(calls.local, 1);
  assert.equal(calls.anthropic, 1);
  assert.equal(result.model, 'tesseract-mrz-local', 'local remains authoritative even when Anthropic also ran');
});

test('compare provider still returns the local result if the Anthropic comparison call itself fails', async () => {
  const { deps, calls } = buildDeps({
    compareWithAnthropic: true,
    anthropic: {
      name: 'anthropic',
      extract: async () => {
        calls.anthropic += 1;
        throw new Error('Claude Vision request failed: rate limited');
      },
    },
  });
  const provider = createCompareProvider(deps);

  const result = await provider.extract(Buffer.from('x'), 'image/jpeg');

  assert.equal(result.model, 'tesseract-mrz-local');
});
