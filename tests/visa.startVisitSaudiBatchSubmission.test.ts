import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { startVisitSaudiBatchSubmission } from '../src/visa/startVisitSaudiBatchSubmission.js';
import {
  buildInMemoryVisaBatchLockStore,
  buildInMemoryVisaSubmissionQueueStore,
} from '../src/visa/visaSubmissionQueueStore.js';
import type { VisaWorkerLoopDependencies } from '../src/visa/visaWorkerLoop.js';
import type { VisitSaudiApplicationDraft } from '../src/visa/types.js';
import type { VisitSaudiPreflightResult } from '../src/visa/visitSaudiPreflight.js';

/**
 * Package 5.33, extended 5.36, updated for the Page3->Page7 flow fix and
 * the Page3->Page4 trigger fix: proves startVisitSaudiBatchSubmission's
 * own wiring -- createVisitSaudiGroup (REAL page-action, REAL Playwright
 * page) runs ONCE, BEFORE runVisaWorkerLoopForBatch (REAL, UNCHANGED)
 * ever claims or processes a single applicant. SAVE is never clicked
 * immediately after Page 3 (see visitSaudiBrowserAutomationAdapter.ts's
 * own doc comment); Page 3's own "Next" IS clicked for real, but this
 * fixture has no Page 4 markup, so both applicants end AMBIGUOUS (never
 * SAVED, never AWAITING_MANUAL_CONTINUATION -- that would require Page 4
 * to genuinely appear). Both halves run against a hand-built LOCAL
 * fixture page, same
 * local-simulation convention as every other VisitSaudi test in this
 * project -- this does NOT, and cannot, prove anything about the real
 * VisitSaudi portal. No real portal, no production DB -- only the
 * in-memory VisaSubmissionQueueStore/VisaBatchLockStore fakes.
 */

function buildDraft(portraitUrl: string): VisitSaudiApplicationDraft {
  return {
    portal: 'visitsaudi',
    firstName: 'Test',
    surname: 'Applicant',
    dateOfBirth: '1990-01-01',
    gender: 'Erkak',
    passportNumber: 'AB1234567',
    passportIssueDate: '2020-01-01',
    passportExpiryDate: '2030-01-01',
    nationality: 'UZBEKISTAN',
    email: 'test@example.com',
    arrivalDate: '2026-12-01',
    personalPortraitUrl: portraitUrl,
  };
}

let browser: Browser;
let page: Page;
let portraitServer: Server;
let portraitServerUrl: string;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();

  portraitServer = createServer((req, res) => {
    if (req.url === '/portrait.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from('fake portrait bytes for Package 5.33'));
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
  await browser.close();
  await new Promise<void>((resolve) => portraitServer.close(() => resolve()));
});

/**
 * One fixture page holding BOTH the group-creation controls (Page 2) and
 * the complete applicant-page controls (Page 3's on-behalf question,
 * upload, every personal-info field, and save) -- Package 5.36 made
 * every one of these evidence-backed. A single shared `window.__eventLog`
 * records each action IN ORDER, so the test can assert group creation
 * happened strictly before any applicant was touched, without needing
 * real multi-page navigation.
 */
async function setBatchFixture(): Promise<void> {
  await page.setContent(`
    <div id="dashboard">
      <button onclick="window.__eventLog.push('applyForGroup'); document.getElementById('dashboard').style.display='none'; document.getElementById('groupForm').style.display='block';">APPLY FOR GROUP</button>
    </div>
    <div id="groupForm" style="display:none">
      <label for="groupName">Group Name*</label>
      <input id="groupName" type="text" />
      <button onclick="window.__eventLog.push('confirmGroup:' + document.getElementById('groupName').value); document.getElementById('groupForm').style.display='none'; document.getElementById('applicantPage').style.display='block';">+</button>
    </div>
    <div id="applicantPage" style="display:none">
      <button onclick="window.__eventLog.push('onBehalf:YES')">Yes</button>
      <button onclick="window.__eventLog.push('onBehalf:NO')">No</button>
      <button id="uploadBtn" onclick="window.__eventLog.push('uploadClicked')">UPLOAD FILE</button>
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

      <button onclick="window.__eventLog.push('save-and-next')">SAVE AND MOVE TO THE NEXT APPLICANT</button>
      <button onclick="window.__eventLog.push('save')">SAVE</button>
      <button onclick="window.__eventLog.push('page3-next')">Next &gt;</button>
    </div>
    <script>
      window.__eventLog = [];
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
    </script>
  `);
}

test('Package 5.33: startVisitSaudiBatchSubmission creates the group ONCE, strictly before any applicant is claimed or touched, then delegates the rest to the unmodified worker loop', async () => {
  await setBatchFixture();

  const queueStore = buildInMemoryVisaSubmissionQueueStore();
  const lockStore = buildInMemoryVisaBatchLockStore();
  const batchId = 'batch-533';
  const groupId = 'group-533';

  const recordA = await queueStore.createRecord({ groupId, batchId, passportIdentityId: 'identity-a' });
  const recordB = await queueStore.createRecord({ groupId, batchId, passportIdentityId: 'identity-b' });

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

  const { buildVisitSaudiBrowserAutomationAdapter } = await import('../src/visa/visitSaudiBrowserAutomationAdapter.js');

  const deps: VisaWorkerLoopDependencies = {
    queueStore,
    lockStore,
    automation: buildVisitSaudiBrowserAutomationAdapter(page),
    checkPreflight,
    findActiveApplicantPositions: async () => [
      { passportIdentityId: 'identity-a', positionInBatch: 1 },
      { passportIdentityId: 'identity-b', positionInBatch: 2 },
    ],
  };

  const result = await startVisitSaudiBatchSubmission(
    page,
    { id: batchId, batchName: '26.10-1' },
    'worker-1',
    [
      { recordId: recordA.id, groupId, passportIdentityId: 'identity-a' },
      { recordId: recordB.id, groupId, passportIdentityId: 'identity-b' },
    ],
    Date.now(),
    deps,
  );

  // The worker loop itself ran, exactly as Package 5.28 already proved it
  // does -- per the Page3->Page7 flow fix, neither applicant's SAVE
  // button is ever clicked; per the Page3->Page4 trigger fix, Page 3's
  // own "Next" IS clicked for real, but since this fixture has no Page 4
  // markup, both end AMBIGUOUS (the click resolved, Page 4 never appeared).
  assert.equal(result.lockOutcome, 'acquired');
  assert.deepEqual(result.batchValidation, { outcome: 'ok' });
  const ambiguousDetail =
    'Page 3\'s forward action was clicked, but Page 4 ("Passport Type") never became visible afterward -- portal page state is unconfirmed';
  assert.deepEqual(result.applicantOutcomes, [
    { recordId: recordA.id, outcome: 'AMBIGUOUS', detail: ambiguousDetail },
    { recordId: recordB.id, outcome: 'AMBIGUOUS', detail: ambiguousDetail },
  ]);

  // Package 5.42: the result also carries a ready, Telegram-ready operator
  // summary, now showing both applicants' AMBIGUOUS detail.
  assert.equal(
    result.operatorSummaryText,
    `VisitSaudi topshirish natijasi -- Batch: 26.10-1\n1-o'rin: AMBIGUOUS\n   ${ambiguousDetail}\n2-o'rin: AMBIGUOUS\n   ${ambiguousDetail}`,
  );

  const eventLog = await page.evaluate(() => (globalThis as unknown as { __eventLog: string[] }).__eventLog);

  // Group creation happened, with the EXACT given batch name, verbatim,
  // strictly BEFORE either applicant's own events.
  assert.deepEqual(
    eventLog.slice(0, 2),
    ['applyForGroup', 'confirmGroup:26.10-1'],
    'group creation must run to completion, in order, using the exact given batch name',
  );
  assert.ok(!eventLog.includes('applyForGroup', 1), 'the group must never be created a second time within one batch submission');

  // Page3->Page7 flow fix: SAVE / SAVE AND MOVE TO THE NEXT APPLICANT
  // must NEVER be clicked here -- that action belongs on Page 7, not
  // immediately after Page 3.
  const saveEvents = eventLog.filter((e) => e === 'save-and-next' || e === 'save');
  assert.deepEqual(saveEvents, [], 'SAVE/SAVE AND MOVE TO THE NEXT APPLICANT must never be clicked immediately after Page 3');

  // Page3->Page4 trigger fix: Page 3's own "Next" must have been clicked
  // once per applicant.
  const nextEvents = eventLog.filter((e) => e === 'page3-next');
  assert.deepEqual(nextEvents, ['page3-next', 'page3-next']);
});
