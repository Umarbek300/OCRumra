import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfirmationMessage, type ConfirmationMessageInput } from '../src/telegram/buildConfirmationMessage.js';
import type { OcrGenderValue } from '../src/db/repositories/passportOcrResult.repo.js';

function ocrField<T extends string = string>(value: T | null) {
  return { value, confidence: value ? ('high' as const) : null };
}

function genderField(value: OcrGenderValue | null) {
  return { value, confidence: value ? ('high' as const) : null };
}

function buildInput(overrides: Partial<ConfirmationMessageInput> = {}): ConfirmationMessageInput {
  return {
    ocrResult: {
      firstName: ocrField('ANNA'),
      surname: ocrField('ERIKSSON'),
      passportNumber: ocrField('L898902C3'),
      dateOfBirth: ocrField('1974-08-12'),
      passportIssueDate: ocrField('2004-01-01'),
      passportExpiryDate: ocrField('2012-04-15'),
      gender: genderField('female'),
    },
    agent: { name: 'Jasur Agent' },
    packageText: '$1400',
    depositText: '$200',
    balanceText: '$1200',
    sheetRowNumber: 5,
    ...overrides,
  };
}

test('buildConfirmationMessage renders every field when everything was found', () => {
  const text = buildConfirmationMessage(buildInput());

  assert.match(text, /✅ Passport qabul qilindi/);
  assert.match(text, /👤 Ism Familiya: ANNA ERIKSSON/);
  assert.match(text, /🛂 Passport №: L898902C3/);
  assert.match(text, /📅 Tug'ilgan sana: 1974-08-12/);
  assert.match(text, /📅 Berilgan sana: 2004-01-01/);
  assert.match(text, /📅 Amal qilish sanasi: 2012-04-15/);
  assert.match(text, /⚧ Jins: Ayol/);
  assert.match(text, /👨‍💼 Agent: Jasur Agent/);
  assert.match(text, /📦 Paket: \$1400/);
  assert.match(text, /💵 Depozit: \$200/);
  assert.match(text, /💰 Qoldiq: \$1200/);
  assert.match(text, /Google Sheet: qator №5/);
  assert.ok(!text.includes('⚠️'), 'no warning markers when nothing is missing');
});

test('buildConfirmationMessage warns explicitly when Berilgan sana (issue date) is missing, never hides it', () => {
  const text = buildConfirmationMessage(
    buildInput({
      ocrResult: { ...buildInput().ocrResult, passportIssueDate: ocrField(null) },
    }),
  );

  assert.match(text, /⚠️ Berilgan sana topilmadi/);
  assert.ok(!text.includes('📅 Berilgan sana:'));
});

test('buildConfirmationMessage warns when Paket was not entered in the caption', () => {
  const text = buildConfirmationMessage(buildInput({ packageText: '' }));
  assert.match(text, /⚠️ Paket kiritilmagan/);
});

test('buildConfirmationMessage warns when Depozit was not entered in the caption', () => {
  const text = buildConfirmationMessage(buildInput({ depositText: '' }));
  assert.match(text, /⚠️ Depozit kiritilmagan/);
});

test('buildConfirmationMessage warns when Qoldiq could not be calculated', () => {
  const text = buildConfirmationMessage(buildInput({ balanceText: '' }));
  assert.match(text, /⚠️ Qoldiq hisoblanmadi/);
});

test('buildConfirmationMessage warns for missing passport number, DOB, expiry date, and gender independently', () => {
  const base = buildInput();
  assert.match(
    buildConfirmationMessage({ ...base, ocrResult: { ...base.ocrResult, passportNumber: ocrField(null) } }),
    /⚠️ Passport raqami topilmadi/,
  );
  assert.match(
    buildConfirmationMessage({ ...base, ocrResult: { ...base.ocrResult, dateOfBirth: ocrField(null) } }),
    /⚠️ Tug'ilgan sana topilmadi/,
  );
  assert.match(
    buildConfirmationMessage({ ...base, ocrResult: { ...base.ocrResult, passportExpiryDate: ocrField(null) } }),
    /⚠️ Amal qilish sanasi topilmadi/,
  );
  assert.match(
    buildConfirmationMessage({ ...base, ocrResult: { ...base.ocrResult, gender: genderField(null) } }),
    /⚠️ Jins aniqlanmadi/,
  );
});

test('buildConfirmationMessage warns when the name is incomplete (either half missing)', () => {
  const base = buildInput();
  assert.match(
    buildConfirmationMessage({ ...base, ocrResult: { ...base.ocrResult, firstName: ocrField(null) } }),
    /⚠️ Ism yoki familiya topilmadi/,
  );
  assert.match(
    buildConfirmationMessage({ ...base, ocrResult: { ...base.ocrResult, surname: ocrField(null) } }),
    /⚠️ Ism yoki familiya topilmadi/,
  );
});

test('buildConfirmationMessage shows a plain dash for Agent with no warning when no agent is linked (an expected, normal state)', () => {
  const text = buildConfirmationMessage(buildInput({ agent: null }));
  assert.match(text, /👨‍💼 Agent: —/);
  assert.ok(!text.includes('⚠️ Agent'));
});

test('buildConfirmationMessage never invents a value — every warning corresponds to a genuinely missing field only', () => {
  const text = buildConfirmationMessage(buildInput());
  // Fully-populated input from buildInput() must produce zero warnings.
  const warningCount = (text.match(/⚠️/g) ?? []).length;
  assert.equal(warningCount, 0);
});
