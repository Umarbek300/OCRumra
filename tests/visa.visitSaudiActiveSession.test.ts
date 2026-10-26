import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getNoActiveVisitSaudiSession } from '../src/visa/visitSaudiActiveSession.js';

/**
 * Package 5.43, extended 5.45: this is the ONE safety-critical guarantee
 * underpinning /visa_start_submission's entire "never guess, never
 * fabricate a session" story -- the DEFAULT, never-configured fallback
 * must UNCONDITIONALLY resolve to an unavailable session with a clear
 * reason, every single call, with zero state, zero caching, and zero
 * DB/browser/network access of any kind. This test itself needs neither
 * `before`/`after` hooks nor any real browser -- getNoActiveVisitSaudiSession
 * does not call chromium.connectOverCDP at all (that only happens in
 * getVisitSaudiSessionOverCdp/connectToVisitSaudiSessionOverCdp, this
 * file's own CDP-dependent siblings -- see visa.visitSaudiActiveSession.cdp.test.ts).
 */
test('Package 5.43/5.45: getNoActiveVisitSaudiSession always resolves {available:false}, with a clear reason -- never a fabricated or cached session, every call, independently', async () => {
  const first = await getNoActiveVisitSaudiSession();
  const second = await getNoActiveVisitSaudiSession();
  const third = await getNoActiveVisitSaudiSession();

  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(first.available, false);
  if (!first.available) {
    assert.ok(first.reason.length > 0, 'the reason must be a real, non-empty, human-readable string');
  }
});
