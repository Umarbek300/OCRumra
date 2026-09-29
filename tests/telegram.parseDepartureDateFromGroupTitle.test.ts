import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDepartureDateFromGroupTitle } from '../src/telegram/parseDepartureDateFromGroupTitle.js';

test('parses "5 October 2026" (single-digit day, English month)', () => {
  assert.deepEqual(parseDepartureDateFromGroupTitle('5 October 2026'), { date: '2026-10-05' });
});

test('parses "20 September 2026" (two-digit day, English month)', () => {
  assert.deepEqual(parseDepartureDateFromGroupTitle('20 September 2026'), { date: '2026-09-20' });
});

test('English month names are case-insensitive', () => {
  assert.deepEqual(parseDepartureDateFromGroupTitle('5 october 2026'), { date: '2026-10-05' });
  assert.deepEqual(parseDepartureDateFromGroupTitle('5 OCTOBER 2026'), { date: '2026-10-05' });
  assert.deepEqual(parseDepartureDateFromGroupTitle('5 OcToBeR 2026'), { date: '2026-10-05' });
});

test('parses every English month name', () => {
  const months = [
    ['January', '01'], ['February', '02'], ['March', '03'], ['April', '04'],
    ['May', '05'], ['June', '06'], ['July', '07'], ['August', '08'],
    ['September', '09'], ['October', '10'], ['November', '11'], ['December', '12'],
  ] as const;
  for (const [name, num] of months) {
    assert.deepEqual(parseDepartureDateFromGroupTitle(`1 ${name} 2026`), { date: `2026-${num}-01` }, name);
  }
});

test('parses Uzbek month names', () => {
  const months = [
    ['yanvar', '01'], ['fevral', '02'], ['mart', '03'], ['aprel', '04'],
    ['may', '05'], ['iyun', '06'], ['iyul', '07'], ['avgust', '08'],
    ['sentyabr', '09'], ['oktyabr', '10'], ['noyabr', '11'], ['dekabr', '12'],
  ] as const;
  for (const [name, num] of months) {
    assert.deepEqual(parseDepartureDateFromGroupTitle(`5 ${name} 2026`), { date: `2026-${num}-05` }, name);
  }
});

test('parses Russian month names (nominative and genitive forms), case-insensitive', () => {
  const months = [
    ['январь', '01'], ['января', '01'],
    ['февраль', '02'], ['февраля', '02'],
    ['март', '03'], ['марта', '03'],
    ['апрель', '04'], ['апреля', '04'],
    ['май', '05'], ['мая', '05'],
    ['июнь', '06'], ['июня', '06'],
    ['июль', '07'], ['июля', '07'],
    ['август', '08'], ['августа', '08'],
    ['сентябрь', '09'], ['сентября', '09'],
    ['октябрь', '10'], ['октября', '10'],
    ['ноябрь', '11'], ['ноября', '11'],
    ['декабрь', '12'], ['декабря', '12'],
  ] as const;
  for (const [name, num] of months) {
    assert.deepEqual(parseDepartureDateFromGroupTitle(`5 ${name} 2026`), { date: `2026-${num}-05` }, name);
  }
  assert.deepEqual(parseDepartureDateFromGroupTitle('5 ОКТЯБРЯ 2026'), { date: '2026-10-05' });
});

test('parses "DD.MM.YYYY" and "D.MM.YYYY"', () => {
  assert.deepEqual(parseDepartureDateFromGroupTitle('05.10.2026'), { date: '2026-10-05' });
  assert.deepEqual(parseDepartureDateFromGroupTitle('5.10.2026'), { date: '2026-10-05' });
  assert.deepEqual(parseDepartureDateFromGroupTitle('20.9.2026'), { date: '2026-09-20' });
});

test('parses plain ISO "YYYY-MM-DD"', () => {
  assert.deepEqual(parseDepartureDateFromGroupTitle('2026-10-05'), { date: '2026-10-05' });
});

test('trims surrounding whitespace before matching', () => {
  assert.deepEqual(parseDepartureDateFromGroupTitle('  5 October 2026  '), { date: '2026-10-05' });
});

test('returns null for a calendar-invalid date (never guesses a nearby valid date)', () => {
  assert.equal(parseDepartureDateFromGroupTitle('31 February 2026'), null);
  assert.equal(parseDepartureDateFromGroupTitle('31.04.2026'), null); // April has 30 days
  assert.equal(parseDepartureDateFromGroupTitle('2026-02-30'), null);
});

test('returns null for an unrecognized month word', () => {
  assert.equal(parseDepartureDateFromGroupTitle('5 Octobre 2026'), null);
  assert.equal(parseDepartureDateFromGroupTitle('5 Foo 2026'), null);
});

test('returns null for null, empty, or whitespace-only input', () => {
  assert.equal(parseDepartureDateFromGroupTitle(null), null);
  assert.equal(parseDepartureDateFromGroupTitle(''), null);
  assert.equal(parseDepartureDateFromGroupTitle('   '), null);
});

test('returns null for a title that is not just a date (never a substring search)', () => {
  assert.equal(parseDepartureDateFromGroupTitle('Group for 5 October 2026 departure'), null);
  assert.equal(parseDepartureDateFromGroupTitle('5 October 2026!'), null);
  assert.equal(parseDepartureDateFromGroupTitle('Batch 5 October 2026'), null);
});

test('returns null for a completely unrelated title', () => {
  assert.equal(parseDepartureDateFromGroupTitle('VIP Passport Group'), null);
  assert.equal(parseDepartureDateFromGroupTitle('Random Chat Name'), null);
});

test('returns null for a partial/malformed numeric date', () => {
  assert.equal(parseDepartureDateFromGroupTitle('05.10.26'), null); // 2-digit year not supported
  assert.equal(parseDepartureDateFromGroupTitle('2026-13-01'), null); // month 13
  assert.equal(parseDepartureDateFromGroupTitle('2026/10/05'), null); // wrong separator
});
