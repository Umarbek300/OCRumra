import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateBalance, formatMoneyForSheet, parsePackageAndDeposit } from '../src/telegram/parsePackageDeposit.js';

test('parsePackageAndDeposit returns both null when there is no caption at all', () => {
  const result = parsePackageAndDeposit(null);
  assert.deepEqual(result, { packageAmount: null, depositAmount: null });
});

test('parsePackageAndDeposit returns both null for an unrelated caption (never guesses)', () => {
  const result = parsePackageAndDeposit('just a normal message with no pricing info');
  assert.deepEqual(result, { packageAmount: null, depositAmount: null });
});

test('parsePackageAndDeposit parses "Package: Standard $1400"', () => {
  const result = parsePackageAndDeposit('Package: Standard $1400');
  assert.deepEqual(result.packageAmount, { amount: 1400, currency: '$' });
});

test('parsePackageAndDeposit parses "Paket: 1400" (Uzbek keyword, no currency)', () => {
  const result = parsePackageAndDeposit('Paket: 1400');
  assert.deepEqual(result.packageAmount, { amount: 1400, currency: null });
});

test('parsePackageAndDeposit parses "Deposit: $200"', () => {
  const result = parsePackageAndDeposit('Deposit: $200');
  assert.deepEqual(result.depositAmount, { amount: 200, currency: '$' });
});

test('parsePackageAndDeposit parses "Depozit: $200" (Uzbek keyword)', () => {
  const result = parsePackageAndDeposit('Depozit: $200');
  assert.deepEqual(result.depositAmount, { amount: 200, currency: '$' });
});

test('parsePackageAndDeposit parses "1400 package, 200 deposit" (value-before-keyword, no currency)', () => {
  const result = parsePackageAndDeposit('1400 package, 200 deposit');
  assert.deepEqual(result.packageAmount, { amount: 1400, currency: null });
  assert.deepEqual(result.depositAmount, { amount: 200, currency: null });
});

test('parsePackageAndDeposit parses both package and deposit from the same multi-line caption', () => {
  const result = parsePackageAndDeposit('Passport for group X\nPackage: Standard $1400\nDeposit: $200');
  assert.deepEqual(result.packageAmount, { amount: 1400, currency: '$' });
  assert.deepEqual(result.depositAmount, { amount: 200, currency: '$' });
});

test('parsePackageAndDeposit handles thousand separators ("$1,400")', () => {
  const result = parsePackageAndDeposit('Package: $1,400');
  assert.deepEqual(result.packageAmount, { amount: 1400, currency: '$' });
});

test('parsePackageAndDeposit is case-insensitive for keywords', () => {
  const result = parsePackageAndDeposit('PACKAGE: $500 / DEPOSIT: $100');
  assert.deepEqual(result.packageAmount, { amount: 500, currency: '$' });
  assert.deepEqual(result.depositAmount, { amount: 100, currency: '$' });
});

test('parsePackageAndDeposit never invents an amount from a bare keyword with no number nearby', () => {
  const result = parsePackageAndDeposit('Package deposit discussion pending, will confirm later');
  assert.deepEqual(result, { packageAmount: null, depositAmount: null });
});

test('parsePackageAndDeposit rejects a non-positive parsed amount rather than accepting zero/garbage', () => {
  const result = parsePackageAndDeposit('Package: $0');
  assert.equal(result.packageAmount, null);
});

// --- tier-word fallback: real captions sometimes name a package tier
// directly, with no literal "package"/"paket" keyword anywhere at all ---

test('parsePackageAndDeposit recognizes a package tier name directly followed by a currency amount, with no "package"/"paket" keyword at all', () => {
  const result = parsePackageAndDeposit('standard $1259 Deposit: $350');
  assert.deepEqual(result.packageAmount, { amount: 1259, currency: '$' });
  assert.deepEqual(result.depositAmount, { amount: 350, currency: '$' });
});

test('parsePackageAndDeposit computes the correct balance for the tier-word fallback case', () => {
  const { packageAmount, depositAmount } = parsePackageAndDeposit('standard $1259 Deposit: $350');
  const balance = calculateBalance(packageAmount, depositAmount);
  assert.deepEqual(balance, { amount: 909, currency: '$' });
});

test('parsePackageAndDeposit tier-word fallback recognizes other known tier names (premium, vip, business, economy, econom, deluxe, basic)', () => {
  assert.deepEqual(parsePackageAndDeposit('premium $2000').packageAmount, { amount: 2000, currency: '$' });
  assert.deepEqual(parsePackageAndDeposit('vip $3000').packageAmount, { amount: 3000, currency: '$' });
  assert.deepEqual(parsePackageAndDeposit('business $1800').packageAmount, { amount: 1800, currency: '$' });
  assert.deepEqual(parsePackageAndDeposit('economy $900').packageAmount, { amount: 900, currency: '$' });
  assert.deepEqual(parsePackageAndDeposit('econom $900').packageAmount, { amount: 900, currency: '$' });
  assert.deepEqual(parsePackageAndDeposit('deluxe $2500').packageAmount, { amount: 2500, currency: '$' });
  assert.deepEqual(parsePackageAndDeposit('basic $700').packageAmount, { amount: 700, currency: '$' });
});

test('parsePackageAndDeposit tier-word fallback never matches a tier word followed only by a bare number with no currency symbol (too weak a signal, never guessed)', () => {
  const result = parsePackageAndDeposit('standard 1259 Deposit: $350');
  assert.equal(result.packageAmount, null);
});

test('parsePackageAndDeposit does not use the tier-word fallback for deposit -- deposit still requires its own explicit keyword', () => {
  const result = parsePackageAndDeposit('standard $1259 vip $500');
  // Only one package-side match is taken (the first tier word found); the
  // second tier word ("vip $500") must never be misread as a deposit, since
  // deposit has no tier-word fallback at all.
  assert.equal(result.depositAmount, null);
});

test('parsePackageAndDeposit prefers an explicit "Package:" keyword match over the tier-word fallback when both are present', () => {
  const result = parsePackageAndDeposit('Package: Standard $1400');
  assert.deepEqual(result.packageAmount, { amount: 1400, currency: '$' }, 'unaffected by the new fallback -- same result as before');
});

// --- calculateBalance ---

test('calculateBalance computes package - deposit when both are present and currencies match', () => {
  const balance = calculateBalance({ amount: 1400, currency: '$' }, { amount: 200, currency: '$' });
  assert.deepEqual(balance, { amount: 1200, currency: '$' });
});

test('calculateBalance computes package - deposit when neither has a currency', () => {
  const balance = calculateBalance({ amount: 1400, currency: null }, { amount: 200, currency: null });
  assert.deepEqual(balance, { amount: 1200, currency: null });
});

test('calculateBalance returns null when package is missing', () => {
  assert.equal(calculateBalance(null, { amount: 200, currency: '$' }), null);
});

test('calculateBalance returns null when deposit is missing', () => {
  assert.equal(calculateBalance({ amount: 1400, currency: '$' }, null), null);
});

test('calculateBalance returns null when both are missing', () => {
  assert.equal(calculateBalance(null, null), null);
});

test('calculateBalance returns null when currencies conflict (never silently mixes units)', () => {
  const balance = calculateBalance({ amount: 1400, currency: '$' }, { amount: 200, currency: '€' });
  assert.equal(balance, null);
});

test('calculateBalance returns null when only one side has an explicit currency (still a conflict, never assumed equal)', () => {
  const balance = calculateBalance({ amount: 1400, currency: '$' }, { amount: 200, currency: null });
  assert.equal(balance, null);
});

// --- formatMoneyForSheet ---

test('formatMoneyForSheet prefixes the currency symbol onto the integer amount', () => {
  assert.equal(formatMoneyForSheet({ amount: 1400, currency: '$' }), '$1400');
});

test('formatMoneyForSheet renders a plain integer with no currency symbol', () => {
  assert.equal(formatMoneyForSheet({ amount: 1400, currency: null }), '1400');
});

test('formatMoneyForSheet keeps up to 2 decimal places for a non-integer amount', () => {
  assert.equal(formatMoneyForSheet({ amount: 199.5, currency: '$' }), '$199.50');
});
