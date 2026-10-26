import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { connectToVisitSaudiSessionOverCdp, getVisitSaudiSessionOverCdp } from '../src/visa/visitSaudiActiveSession.js';

/**
 * ============================================================================
 * Phase 2e / A-bosqich (Package 5.44) -- LOCAL, portal-free, tunnel-free
 * proof that connectToVisitSaudiSessionOverCdp's own connect + find-page
 * mechanism works, exactly as designed, with nothing guessed.
 * ============================================================================
 *
 * Each test launches its OWN, throwaway Chromium instance via
 * `chromium.launch()` -- no `userDataDir` is ever given, so Playwright
 * creates a brand-new, TEMPORARY profile per launch, discarded entirely
 * once `browser.close()` resolves. This is NEVER the operator's real
 * Chrome, NEVER a shared or persistent profile, and carries no cookie or
 * session data from any earlier run or any real machine. A separate
 * `connectOverCDP` call then attaches to that SAME throwaway instance's
 * own `--remote-debugging-port`, mirroring the real Windows-Chrome-via-
 * tunnel scenario's own SHAPE (two independent Playwright connections to
 * one Chrome process) entirely offline. No real VisitSaudi portal, no
 * production server, and no production database is ever touched by this
 * file.
 */

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

let operatorBrowser: Browser | undefined;

after(async () => {
  // Safety net only -- every test below closes its own operatorBrowser
  // explicitly; this just guarantees nothing lingers if an assertion
  // throws mid-test.
  await operatorBrowser?.close().catch(() => undefined);
});

test('Package 5.44: a successful CDP connection with EXACTLY ONE matching page returns that page', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>VisitSaudi Dashboard</p>');

  const result = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');

  assert.equal(result.outcome, 'connected');
  if (result.outcome !== 'connected') throw new Error('unreachable');
  assert.equal(await result.page.locator('p').textContent(), 'VisitSaudi Dashboard');
  assert.equal(typeof result.release, 'function');

  await result.release();
  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.44: a failed connection (nothing listening on that port) resolves connection-failed -- never throws, never a fabricated session', async () => {
  const port = await findFreePort(); // guaranteed nothing listens here -- the server used to find it is closed before this runs
  const result = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'anything', { connectTimeoutMs: 1000 });
  assert.deepEqual(result, { outcome: 'connection-failed' });
});

test('Package 5.44: a real connection with NO page matching the expected anchor resolves page-not-found -- never guesses a wrong tab', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>Some Completely Unrelated Page</p>');

  const result = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard', { pageTimeoutMs: 300 });
  assert.deepEqual(result, { outcome: 'page-not-found' });

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.44: TWO pages matching the same anchor resolves multiple-pages-found with the correct count -- never guesses which tab to use', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const pageA = await operatorBrowser.newPage();
  await pageA.setContent('<p>VisitSaudi Dashboard</p>');
  const pageB = await operatorBrowser.newPage();
  await pageB.setContent('<p>VisitSaudi Dashboard</p>');

  const result = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');
  assert.deepEqual(result, { outcome: 'multiple-pages-found', count: 2 });

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.44: after a page-not-found (or multiple-pages-found) result, the CDP endpoint is left healthy for a SUBSEQUENT connection -- proving the first connection was cleanly released, never left hanging, and the operator browser itself was never closed by this function', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>Something Else Entirely</p>');

  const first = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard', { pageTimeoutMs: 300 });
  assert.equal(first.outcome, 'page-not-found');

  // The SAME underlying operator browser/page (never relaunched) is still
  // open and usable -- proof this function never closed the operator's
  // own browser, only released ITS OWN connection to it.
  await page.setContent('<p>VisitSaudi Dashboard</p>');
  const second = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');
  assert.equal(second.outcome, 'connected');
  if (second.outcome === 'connected') {
    await second.release();
  }

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.44: each test\'s browser is a freshly-launched, temporary, throwaway profile -- zero cookies, never any leftover or real operator session data', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();

  const cookies = await page.context().cookies();
  assert.deepEqual(cookies, [], 'a freshly-launched throwaway profile must start with zero cookies -- never a leftover/real session');

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.45: calling release() on a \'connected\' result cleanly disconnects -- the CDP endpoint stays healthy for a later, independent connection, and the operator\'s own browser is never closed', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>VisitSaudi Dashboard</p>');

  const first = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');
  assert.equal(first.outcome, 'connected');
  if (first.outcome !== 'connected') throw new Error('unreachable');
  await first.release();

  // A completely independent, later connection to the SAME operator
  // browser must still work -- proof release() only tore down the FIRST
  // connection's own CDP session, never the underlying Chrome process.
  const second = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');
  assert.equal(second.outcome, 'connected');
  if (second.outcome === 'connected') {
    await second.release();
  }

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.45: release() never throws even if called twice (best-effort cleanup)', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>VisitSaudi Dashboard</p>');

  const result = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');
  assert.equal(result.outcome, 'connected');
  if (result.outcome !== 'connected') throw new Error('unreachable');

  await result.release();
  await assert.doesNotReject(() => result.release());

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

/**
 * ============================================================================
 * Package 5.45 -- getVisitSaudiSessionOverCdp: maps the above diagnostic
 * outcomes onto VisitSaudiSessionAvailability, with its own specific,
 * human-readable `reason` per unavailable case. Still entirely local,
 * portal-free, tunnel-free.
 * ============================================================================
 */

test('Package 5.45: getVisitSaudiSessionOverCdp with NO endpoint resolves unavailable with a "not configured" reason, without attempting any connection', async () => {
  const result = await getVisitSaudiSessionOverCdp(undefined, 'VisitSaudi Dashboard');
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /not configured/i);
  }
});

test('Package 5.45: getVisitSaudiSessionOverCdp maps a failed connection to a clear, specific "tunnel or Chrome may be down" reason', async () => {
  const port = await findFreePort();
  const result = await getVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard', { connectTimeoutMs: 1000 });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /tunnel|chrome|down/i);
  }
});

test('Package 5.45: getVisitSaudiSessionOverCdp maps page-not-found to a reason naming the expected anchor text', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>Something Unrelated</p>');

  const result = await getVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard', { pageTimeoutMs: 300 });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /VisitSaudi Dashboard/);
  }

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.45: getVisitSaudiSessionOverCdp maps multiple-pages-found to a reason naming the count', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const pageA = await operatorBrowser.newPage();
  await pageA.setContent('<p>VisitSaudi Dashboard</p>');
  const pageB = await operatorBrowser.newPage();
  await pageB.setContent('<p>VisitSaudi Dashboard</p>');

  const result = await getVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /2/);
  }

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.45: getVisitSaudiSessionOverCdp maps a successful, unambiguous connection to {available:true, page, release}', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>VisitSaudi Dashboard</p>');

  const result = await getVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'VisitSaudi Dashboard');
  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(await result.page.locator('p').textContent(), 'VisitSaudi Dashboard');
    await result.release();
  }

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

/**
 * ============================================================================
 * Package 5.46 -- connectToVisitSaudiSessionOverCdp/getVisitSaudiSessionOverCdp
 * now also accept an ARRAY of candidate anchor texts (a RESUMED batch's tab
 * is no longer on the dashboard -- see visaStartSubmissionCommand.ts's own
 * doc comment for why). A page matches if it shows ANY ONE of the given
 * candidates. A single string (every test above) is unchanged.
 * ============================================================================
 */

test('Package 5.46: an array of candidate anchors matches a page showing only the SECOND candidate -- a single string is never the only option', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>Passport Type</p>'); // simulates a resumed session on Page 4, never the dashboard

  const result = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, ['APPLY FOR GROUP', 'Passport Type', 'INSURANCE COVERAGE']);
  assert.equal(result.outcome, 'connected');
  if (result.outcome !== 'connected') throw new Error('unreachable');
  await result.release();

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.46: an array of candidate anchors still resolves page-not-found when NONE of them appear on any open page', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>Something Completely Unrelated</p>');

  const result = await connectToVisitSaudiSessionOverCdp(
    `http://127.0.0.1:${port}`,
    ['APPLY FOR GROUP', 'Passport Type', 'INSURANCE COVERAGE'],
    { pageTimeoutMs: 300 },
  );
  assert.deepEqual(result, { outcome: 'page-not-found' });

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.46: TWO pages each matching a DIFFERENT candidate anchor still resolves multiple-pages-found -- never guesses which one is real', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const pageA = await operatorBrowser.newPage();
  await pageA.setContent('<p>Passport Type</p>');
  const pageB = await operatorBrowser.newPage();
  await pageB.setContent('<p>INSURANCE COVERAGE</p>');

  const result = await connectToVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, ['APPLY FOR GROUP', 'Passport Type', 'INSURANCE COVERAGE']);
  assert.deepEqual(result, { outcome: 'multiple-pages-found', count: 2 });

  await operatorBrowser.close();
  operatorBrowser = undefined;
});

test('Package 5.46: getVisitSaudiSessionOverCdp with an array of candidates maps a page-not-found reason that names every candidate', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const page = await operatorBrowser.newPage();
  await page.setContent('<p>Something Unrelated</p>');

  const result = await getVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, ['APPLY FOR GROUP', 'Passport Type'], { pageTimeoutMs: 300 });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /APPLY FOR GROUP/);
    assert.match(result.reason, /Passport Type/);
  }

  await operatorBrowser.close();
  operatorBrowser = undefined;
});
