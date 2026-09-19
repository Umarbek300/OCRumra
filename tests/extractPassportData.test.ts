import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { extractPassportData } from '../src/ocr/extractPassportData.js';

const SAMPLE_BUFFER = Buffer.from('not-a-real-image-just-test-bytes');

function field(value: string | null, confidence: 'high' | 'medium' | 'low' | null) {
  return { value, confidence };
}

function validClaudeJson() {
  return {
    firstName: field('Jane', 'high'),
    middleName: field(null, null),
    surname: field('Doe', 'high'),
    passportNumber: field('X1234567', 'high'),
    dateOfBirth: field('1990-05-15', 'high'),
    passportIssueDate: field('2020-01-01', 'high'),
    passportExpiryDate: field('2030-01-01', 'high'),
    gender: field('female', 'high'),
    nationality: field('UZB', 'medium'),
    placeOfBirth: field(null, null),
    issuingAuthority: field(null, null),
    mrz: field(null, null),
  };
}

/** Minimal mock — extractPassportData only ever calls client.messages.parse(). */
function mockClient(parsedOutput: unknown): Anthropic {
  return {
    messages: {
      parse: async () => ({ parsed_output: parsedOutput }),
    },
  } as unknown as Anthropic;
}

function mockClientThatThrows(error: unknown): Anthropic {
  return {
    messages: {
      parse: async () => {
        throw error;
      },
    },
  } as unknown as Anthropic;
}

test('extractPassportData returns a validated result for a valid structured Claude response', async () => {
  const client = mockClient(validClaudeJson());
  const result = await extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client);

  assert.equal(result.firstName.value, 'Jane');
  assert.equal(result.surname.value, 'Doe');
  assert.equal(result.passportNumber.value, 'X1234567');
  assert.equal(result.dateOfBirth.value, '1990-05-15');
  assert.equal(result.gender.value, 'female');
  // nationality is 'medium' but isn't a critical field; every critical field is 'high'.
  assert.equal(result.overallConfidence, 'high');
  assert.ok(result.model);
});

test('extractPassportData throws when Claude does not return schema-conforming structured output (parsed_output null)', async () => {
  const client = mockClient(null);
  await assert.rejects(
    () => extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client),
    /did not match the expected passport extraction schema/,
  );
});

test('extractPassportData rejects a malformed response missing required fields', async () => {
  const malformed = validClaudeJson() as Record<string, unknown>;
  delete malformed.passportNumber;
  const client = mockClient(malformed);

  await assert.rejects(
    () => extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client),
    /failed passport extraction validation/,
  );
});

test('extractPassportData rejects a response with an invalid date format', async () => {
  const malformed = { ...validClaudeJson(), dateOfBirth: field('15/05/1990', 'high') };
  const client = mockClient(malformed);

  await assert.rejects(
    () => extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client),
    /failed passport extraction validation/,
  );
});

test('extractPassportData wraps a generic Claude API failure without leaking details', async () => {
  const client = mockClientThatThrows(new Error('some internal detail that must not leak'));

  await assert.rejects(async () => {
    try {
      await extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('some internal detail'));
      assert.match(error.message, /Claude Vision request failed/);
      throw error;
    }
  });
});

test('extractPassportData maps a typed Anthropic AuthenticationError to a sanitized category', async () => {
  const authError = new Anthropic.AuthenticationError(401, {}, 'Invalid API key: sk-ant-super-secret-value', new Headers());
  const client = mockClientThatThrows(authError);

  await assert.rejects(async () => {
    try {
      await extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /authentication failed/);
      assert.ok(!error.message.includes('sk-ant-super-secret-value'));
      throw error;
    }
  });
});

test('extractPassportData surfaces a bounded, structural detail for a BadRequestError', async () => {
  const badRequestError = new Anthropic.BadRequestError(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0.content.0.image.source.base64.data: image exceeds 5 MB maximum' } },
    'Bad request',
    new Headers(),
  );
  const client = mockClientThatThrows(badRequestError);

  await assert.rejects(async () => {
    try {
      await extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /bad request: messages\.0\.content\.0\.image\.source\.base64\.data: image exceeds 5 MB maximum/);
      throw error;
    }
  });
});

test('extractPassportData truncates an overly long BadRequestError detail', async () => {
  const longMessage = 'x'.repeat(500);
  const badRequestError = new Anthropic.BadRequestError(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: longMessage } },
    'Bad request',
    new Headers(),
  );
  const client = mockClientThatThrows(badRequestError);

  await assert.rejects(async () => {
    try {
      await extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('x'.repeat(200)));
      assert.ok(!error.message.includes('x'.repeat(201)));
      throw error;
    }
  });
});

test('extractPassportData reports a bounded raw-shape snapshot when the error body has no nested message', async () => {
  // Reproduces what production actually saw: a BadRequestError whose .error
  // field doesn't match the expected { error: { message } } envelope.
  const badRequestError = new Anthropic.BadRequestError(400, { type: 'error', foo: 'bar' }, 'Bad request', new Headers());
  const client = mockClientThatThrows(badRequestError);

  await assert.rejects(async () => {
    try {
      await extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no further detail from Claude \(raw shape: /);
      assert.match(error.message, /errorFieldType=object/);
      assert.match(error.message, /errorFieldKeys=\[type,foo\]/);
      assert.match(error.message, /errorFieldPreview=\{"type":"error","foo":"bar"\}/);
      throw error;
    }
  });
});

test('extractPassportData reports a bounded raw-shape snapshot when the error body is missing entirely', async () => {
  const badRequestError = new Anthropic.BadRequestError(400, undefined, 'Bad request', new Headers());
  const client = mockClientThatThrows(badRequestError);

  await assert.rejects(async () => {
    try {
      await extractPassportData(SAMPLE_BUFFER, 'image/jpeg', client);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no further detail from Claude \(raw shape: sdkType=null errorFieldType=undefined/);
      throw error;
    }
  });
});

test('extractPassportData rejects an unsupported image mime type before calling Claude', async () => {
  let called = false;
  const client: Anthropic = {
    messages: {
      parse: async () => {
        called = true;
        return { parsed_output: validClaudeJson() };
      },
    },
  } as unknown as Anthropic;

  await assert.rejects(() => extractPassportData(SAMPLE_BUFFER, 'application/pdf', client), /Unsupported image mime type/);
  assert.equal(called, false);
});
