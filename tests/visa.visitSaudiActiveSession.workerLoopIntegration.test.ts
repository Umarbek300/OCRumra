import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { getVisitSaudiSessionOverCdp } from '../src/visa/visitSaudiActiveSession.js';
import { buildVisitSaudiBrowserAutomationAdapter } from '../src/visa/visitSaudiBrowserAutomationAdapter.js';
import {
  buildInMemoryVisaBatchLockStore,
  buildInMemoryVisaSubmissionQueueStore,
} from '../src/visa/visaSubmissionQueueStore.js';
import { runVisaWorkerLoopForBatch, type VisaWorkerLoopDependencies } from '../src/visa/visaWorkerLoop.js';
import type { VisitSaudiApplicationDraft } from '../src/visa/types.js';
import type { VisitSaudiPreflightResult } from '../src/visa/visitSaudiPreflight.js';

/**
 * ============================================================================
 * Phase 2e / B-bosqich (Package 5.45) -- the ONE genuinely new risk this
 * phase introduces, proven locally: does a Page ACQUIRED OVER CDP
 * (getVisitSaudiSessionOverCdp, i.e. the exact mechanism the real
 * operator-tunnel flow will use) work correctly as the `page` argument to
 * the EXISTING, already-thoroughly-tested worker loop
 * (runVisaWorkerLoopForBatch, buildVisitSaudiBrowserAutomationAdapter) --
 * with no DB (in-memory stores, same convention as
 * visa.startVisitSaudiBatchSubmission.test.ts), no tunnel, no real
 * portal. Scoped to 2 applicants (not the full 10) -- the 10-applicant
 * SAVE/SAVE-AND-MOVE-TO-THE-NEXT-APPLICANT sequencing and non-cross-
 * contamination guarantee is ALREADY proven, independently, against a
 * plainly-launched page (visa.visitSaudiBrowserAutomationAdapter.test.ts's
 * own 10-applicant test) -- Playwright's own `Page` API is identical
 * regardless of whether the Browser came from `launch()` or
 * `connectOverCDP()`, so re-proving the SAME sequencing logic again here
 * would be redundant; what specifically needs proving HERE is that a
 * CDP-sourced page is a correct drop-in replacement at all.
 */

function buildDraft(portraitUrl: string): VisitSaudiApplicationDraft {
  return {
    portal: 'visitsaudi',
    firstName: 'Test',
    surname: 'Applicant',
    dateOfBirth: '1990-01-01',
    gender: 'Erkak',
    passportNumber: 'EF2468013',
    passportIssueDate: '2020-01-01',
    passportExpiryDate: '2030-01-01',
    nationality: 'UZBEKISTAN',
    email: 'test@example.com',
    arrivalDate: '2026-12-01',
    personalPortraitUrl: portraitUrl,
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
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

let operatorBrowser: Browser;
let portraitServer: Server;
let portraitServerUrl: string;

before(async () => {
  portraitServer = createHttpServer((req, res) => {
    if (req.url === '/portrait.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from('fake portrait bytes for Package 5.45'));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => portraitServer.listen(0, '127.0.0.1', resolve));
  const address = portraitServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('test portrait server did not bind to a port');
  }
  portraitServerUrl = `http://127.0.0.1:${address.port}/portrait.jpg`;
});

after(async () => {
  await operatorBrowser?.close().catch(() => undefined);
  await new Promise<void>((resolve) => portraitServer.close(() => resolve()));
});

/** Same Page 3 fixture shape as visa.startVisitSaudiBatchSubmission.test.ts's own setBatchFixture -- deliberately not re-derived differently. */
async function setApplicantFixture(page: import('playwright').Page): Promise<void> {
  await page.setContent(`
    <button onclick="window.__saveClickLog.push('onBehalf:YES')">YES</button>
    <button onclick="window.__saveClickLog.push('onBehalf:NO')">NO</button>
    <button id="uploadBtn">UPLOAD FILE</button>
    <input type="file" id="fileInput" style="display:none" />

    <label for="nationality">Country of Nationality*</label>
    <select id="nationality"><option value="">Select</option><option>Uzbekistan</option></select>
    <label for="firstName">First Name or Given Name (English)*</label>
    <input type="text" id="firstName" />
    <label for="lastName">Last Name or Family Name (English)*</label>
    <input type="text" id="lastName" />
    <label for="gender">Gender*</label>
    <select id="gender"><option value="">Select</option><option>Male</option><option>Female</option></select>
    <label for="maritalStatus">Marital Status*</label>
    <select id="maritalStatus"><option value="">Select</option><option>Single</option><option>Married</option></select>
    <label for="dateOfBirth">Date of Birth *</label>
    <input type="text" id="dateOfBirth" />
    <label for="countryOfBirth">Country of Birth*</label>
    <select id="countryOfBirth"><option value="">Select</option><option>Uzbekistan</option></select>
    <label for="cityOfBirth">City of Birth*</label>
    <input type="text" id="cityOfBirth" />
    <label for="profession">Profession*</label>
    <input type="text" id="profession" />
    <p>Current Residence Address</p>
    <label for="residenceCountry">Country*</label>
    <select id="residenceCountry"><option value="">Select</option><option>Uzbekistan</option></select>
    <label for="residenceCity">City*</label>
    <input type="text" id="residenceCity" />
    <label for="residenceAddress">Address*</label>
    <input type="text" id="residenceAddress" />

    <button onclick="window.__saveClickLog.push('save-and-next')">SAVE AND MOVE TO THE NEXT APPLICANT</button>
    <button onclick="window.__saveClickLog.push('save')">SAVE</button>
    <button onclick="window.__saveClickLog.push('page3-next')">Next &gt;</button>
    <script>
      window.__saveClickLog = window.__saveClickLog || [];
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
    </script>
  `);
}

test('Package 5.45, updated for the Page3->Page7 flow fix and the Page3->Page4 trigger fix: a Page ACQUIRED OVER CDP (the real operator-tunnel mechanism) correctly drives the existing, unmodified worker loop for a 2-applicant batch -- SAVE/SAVE AND MOVE TO THE NEXT APPLICANT is never clicked, Page 3\'s own "Next" IS clicked, both end AMBIGUOUS (this fixture has no Page 4 markup), entirely local (no DB, no tunnel, no real portal)', async () => {
  const port = await findFreePort();
  operatorBrowser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const operatorPage = await operatorBrowser.newPage();
  await operatorPage.setContent('<p>APPLY FOR GROUP</p>');

  const session = await getVisitSaudiSessionOverCdp(`http://127.0.0.1:${port}`, 'APPLY FOR GROUP');
  assert.equal(session.available, true);
  if (!session.available) throw new Error('unreachable');

  try {
    // Once acquired, the SAME CDP-sourced page is driven exactly like
    // any other Page throughout the real worker loop -- this mirrors the
    // real flow, where startVisitSaudiBatchSubmission's own group
    // creation would run on this page BEFORE per-applicant processing.
    // This test skips group creation (out of this test's own scope,
    // already proven elsewhere) and sets the applicant fixture directly.
    await setApplicantFixture(session.page);

    const queueStore = buildInMemoryVisaSubmissionQueueStore();
    const lockStore = buildInMemoryVisaBatchLockStore();
    const batchId = 'batch-545';
    const groupId = 'group-545';

    const recordA = await queueStore.createRecord({ groupId, batchId, passportIdentityId: 'identity-a' });
    const recordB = await queueStore.createRecord({ groupId, batchId, passportIdentityId: 'identity-b' });

    const adapter = buildVisitSaudiBrowserAutomationAdapter(session.page);

    const checkPreflight = async (): Promise<VisitSaudiPreflightResult> => ({
      passportIdentityId: 'irrelevant',
      sheetRowNumber: null,
      ready: true,
      errors: [],
      draft: buildDraft(portraitServerUrl),
      expectedDateOfArrival: '2026-12-01',
      expectedDateOfDeparture: '2026-12-10',
      maritalStatus: 'SINGLE',
      countryOfBirth: 'UZBEKISTAN',
      cityOfBirth: 'Tashkent',
      countryOfResidence: 'UZBEKISTAN',
      cityOfResidence: 'Tashkent',
      profession: 'WORKER',
    });

    const deps: VisaWorkerLoopDependencies = {
      queueStore,
      lockStore,
      automation: adapter,
      checkPreflight,
      findActiveApplicantPositions: async () => [
        { passportIdentityId: 'identity-a', positionInBatch: 1 },
        { passportIdentityId: 'identity-b', positionInBatch: 2 },
      ],
    };

    const result = await runVisaWorkerLoopForBatch(
      batchId,
      'worker-1',
      [
        { recordId: recordA.id, groupId, passportIdentityId: 'identity-a' },
        { recordId: recordB.id, groupId, passportIdentityId: 'identity-b' },
      ],
      Date.now(),
      deps,
    );

    assert.equal(result.lockOutcome, 'acquired');
    assert.deepEqual(result.batchValidation, { outcome: 'ok' });
    const ambiguousDetail =
      'Page 3\'s forward action was clicked, but Page 4 ("Passport Type") never became visible afterward -- portal page state is unconfirmed';
    assert.deepEqual(result.applicantOutcomes, [
      { recordId: recordA.id, outcome: 'AMBIGUOUS', detail: ambiguousDetail },
      { recordId: recordB.id, outcome: 'AMBIGUOUS', detail: ambiguousDetail },
    ]);

    const saveClickLog = await session.page.evaluate(() => (globalThis as unknown as { __saveClickLog: string[] }).__saveClickLog);
    assert.deepEqual(
      saveClickLog.filter((e) => e === 'save-and-next' || e === 'save'),
      [],
      'SAVE/SAVE AND MOVE TO THE NEXT APPLICANT must never be clicked immediately after Page 3 -- the same fix, now proven over a CDP-acquired page',
    );
    assert.deepEqual(
      saveClickLog.filter((e) => e === 'page3-next'),
      ['page3-next', 'page3-next'],
      'Page 3\'s own "Next" must be clicked once per applicant -- the same Page3->Page4 trigger fix, now proven over a CDP-acquired page',
    );
  } finally {
    await session.release();
  }

  await operatorBrowser.close();
});
