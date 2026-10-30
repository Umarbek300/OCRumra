import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { pool } from '../src/db/pool.js';
import { assignVisaBatch } from '../src/visa/assignVisaBatch.js';
import { createPassportIdentity } from '../src/db/repositories/passportIdentity.repo.js';
import { createQueueForBatch, createSubmissionAttempt } from '../src/db/repositories/visaSubmissionQueue.repo.js';
import { defaultDependencies, visaStartSubmissionCommand } from '../src/visa/visaStartSubmissionCommand.js';
import type { VisitSaudiApplicationDraft } from '../src/visa/types.js';
import type { VisitSaudiPreflightResult } from '../src/visa/visitSaudiPreflight.js';

/**
 * ============================================================================
 * Package 5.43 -- full DB-integration tests for visaStartSubmissionCommand,
 * following this project's own established convention for every other
 * *Command.ts test file (visa.visaQueueBatchCommand.test.ts,
 * visa.visaSubmissionStatusCommand.test.ts, ...): a REAL, isolated
 * `ocrumra_test` Postgres database, real INSERTs, never mocked repos.
 * ============================================================================
 *
 * Only the two genuinely-EXTERNAL dependencies are ever injected as fakes:
 *   - getActiveSession: no real browser/session mechanism exists yet (see
 *     visitSaudiActiveSession.ts's own doc comment) -- the STARTED test
 *     below injects a real, LOCAL Playwright page (chromium.launch, same
 *     "hand-built local fixture" convention as every other VisitSaudi
 *     test in this project) standing in for a human's own, already-
 *     logged-in session; it does NOT, and cannot, prove anything about
 *     the real VisitSaudi portal.
 *   - checkPreflight: the real checkVisitSaudiApplicantPreflight reads a
 *     Google Sheet -- out of scope for a DB-integration test, same
 *     convention visa.startVisitSaudiBatchSubmission.test.ts's own fake
 *     checkPreflight already established.
 * Every other dependency (buildQueueStore, buildLockStore,
 * findActiveApplicantPositions, buildAutomation) is this file's REAL,
 * Postgres-backed default -- proving the actual DB wiring, not a double.
 */

let idCounter = 0;
function uniqueChatId(): number {
  idCounter += 1;
  return -1 * (Date.now() * 1000 + idCounter);
}
function uniquePassportNumber(): string {
  idCounter += 1;
  return `STARTSUBCMDTEST${Date.now()}${idCounter}`;
}

const DEPARTURE_DATE = '2026-12-15';

async function createGroup(): Promise<{ groupId: string; chatId: number }> {
  const chatId = uniqueChatId();
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date, telegram_chat_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Start Submission Command Test Group', DEPARTURE_DATE, chatId],
  );
  assert.ok(group);
  return { groupId: group.id, chatId };
}

async function createActiveApplicant(groupId: string): Promise<{ applicantId: string; batchId: string; passportIdentityId: string }> {
  const identity = await createPassportIdentity(uniquePassportNumber(), '1990-01-01');
  assert.ok(identity);
  const assignment = await assignVisaBatch(groupId, identity.id, 'visitsaudi', DEPARTURE_DATE);
  return { applicantId: assignment.id, batchId: assignment.batchId, passportIdentityId: identity.id };
}

/** Mirrors visaQueueBatchCommand's own internal queueing steps directly -- this test needs genuine PENDING rows to already exist, as if an operator had already run /visa_queue_batch. */
async function queueBatch(batchId: string, requestedBy: string): Promise<void> {
  const attempt = await createSubmissionAttempt(batchId, requestedBy);
  const created = await createQueueForBatch(batchId, attempt.id);
  assert.ok(created, 'createQueueForBatch must succeed against a freshly-created attempt');
}

async function cleanupAll(groupIds: string[]): Promise<void> {
  for (const groupId of groupIds) {
    await pool.query(
      `DELETE FROM visa_operator_alerts WHERE visa_submission_queue_id IN (SELECT id FROM visa_submission_queue WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM visa_submission_queue WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_submission_attempts WHERE batch_id IN (SELECT id FROM visa_batches WHERE group_id = $1)`, [
      groupId,
    ]);
    await pool.query(`DELETE FROM visa_batch_applicants WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM visa_batches WHERE group_id = $1`, [groupId]);
    await pool.query(
      `DELETE FROM passport_identity WHERE id IN (SELECT passport_identity_id FROM visa_batch_applicants WHERE group_id = $1)`,
      [groupId],
    );
    await pool.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
  }
}

test('visaStartSubmissionCommand: a plain member is rejected, and nothing is touched', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaStartSubmissionCommand({ telegramChatId: chatId, authorStatus: 'member', requestedBy: 'operator:x' });
    assert.deepEqual(outcome, { kind: 'UNAUTHORIZED' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStartSubmissionCommand: GROUP_NOT_FOUND for a chat id the system has never seen', async () => {
  const outcome = await visaStartSubmissionCommand({ telegramChatId: uniqueChatId(), authorStatus: 'administrator', requestedBy: 'operator:x' });
  assert.deepEqual(outcome, { kind: 'GROUP_NOT_FOUND' });
});

test('visaStartSubmissionCommand: NO_BATCH when the group has never had a VisitSaudi batch', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const outcome = await visaStartSubmissionCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:x' });
    assert.deepEqual(outcome, { kind: 'NO_BATCH' });
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStartSubmissionCommand: NOTHING_QUEUED when a batch exists with an active applicant, but /visa_queue_batch was never run', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    await createActiveApplicant(groupId);

    const outcome = await visaStartSubmissionCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:x' });
    assert.equal(outcome.kind, 'NOTHING_QUEUED');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStartSubmissionCommand: THE real safety guarantee -- with genuinely queued PENDING applicants and NO overridden dependencies (the real default getActiveSession), the command safely stops at NO_ACTIVE_SESSION and touches no queue row at all', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    await queueBatch(batchId, 'operator:setup');

    // Deliberately no deps argument at all -- this is THE real, unmodified default.
    // VISITSAUDI_CDP_ENDPOINT is unset in this test environment, so this
    // must fall back to getNoActiveVisitSaudiSession's own reason, never
    // attempt a real CDP connection.
    const outcome = await visaStartSubmissionCommand({ telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:x' });
    assert.equal(outcome.kind, 'NO_ACTIVE_SESSION');
    if (outcome.kind === 'NO_ACTIVE_SESSION') {
      assert.match(outcome.reason, /configured/i);
    }

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE batch_id = $1', [batchId]);
    assert.ok(
      rows.every((r) => r.status === 'PENDING'),
      'NO_ACTIVE_SESSION must never claim/touch a single queue row -- every row stays exactly PENDING',
    );
  } finally {
    await cleanupAll([groupId]);
  }
});

function buildDraft(portraitUrl: string): VisitSaudiApplicationDraft {
  return {
    portal: 'visitsaudi',
    firstName: 'Test',
    surname: 'Applicant',
    dateOfBirth: '1990-01-01',
    gender: 'Erkak',
    passportNumber: 'CD7654321',
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
      res.end(Buffer.from('fake portrait bytes for Package 5.43'));
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

/** Same group-creation + Page 3 fixture as visa.startVisitSaudiBatchSubmission.test.ts's own setBatchFixture -- deliberately NOT re-derived differently, so this test exercises the SAME real page-action/automation code the sibling test already proves correct. */
/** Package 5.46: the same applicant-page field markup, reused by BOTH fixtures below -- never re-derived differently for the fresh vs resumed case. */
const APPLICANT_PAGE_HTML = `
  <div id="formPersonalInfo">
    <button onclick="window.__eventLog.push('onBehalf:YES')">Yes</button>
    <button onclick="window.__eventLog.push('onBehalf:NO')">No</button>
  </div>
  <button id="uploadBtn">UPLOAD FILE</button>
  <input type="file" id="fileInput" style="display:none" />
  <div id="cropModal" style="display:none">
    <div>Crop Image</div>
    <button class="rounded-button upload-result">Crop</button>
  </div>

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
  <label for="DateOfBirth">Date of Birth *</label>
  <input type="text" id="DateOfBirth" readonly style="cursor:pointer" />
  <div id="calendarPopup" style="display:none">
    <select class="datepick-month-year" title="Change the month"></select>
    <select class="datepick-month-year" title="Change the year"></select>
    <div id="calendarDays"></div>
  </div>
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
`;

/** FRESH batch: the operator's page starts on the dashboard; APPLY FOR GROUP must be clicked to reveal the applicant fields. `window.__eventLog` records whether (and when) that happened. */
async function setBatchFixture(): Promise<void> {
  await page.setContent(`
    <div id="dashboard">
      <button onclick="window.__eventLog.push('applyForGroup'); document.getElementById('dashboard').style.display='none'; document.getElementById('groupForm').style.display='block';">APPLY FOR GROUP</button>
    </div>
    <div id="groupForm" style="display:none">
      <label for="groupName">Group Name*</label>
      <input id="groupName" type="text" />
      <button onclick="window.__eventLog.push('confirmGroup'); document.getElementById('groupForm').style.display='none'; document.getElementById('applicantPage').style.display='block';">+</button>
    </div>
    <div id="applicantPage" style="display:none">
      ${APPLICANT_PAGE_HTML}
    </div>
    <script>
      window.__eventLog = [];
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
      document.getElementById('fileInput').addEventListener('change', () => {
        document.getElementById('cropModal').style.display = 'block';
      });
      document.querySelector('#cropModal button.upload-result').addEventListener('click', () => {
        document.getElementById('cropModal').style.display = 'none';
      });

      // Calendar-widget fix: a hand-built stand-in for the real jQuery
      // "datepick"-family widget (see selectDateFromCalendarWidget's own
      // doc comment, visitSaudiPageActions.ts, for the full real
      // evidence this fixture mirrors).
      (function() {
        var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var calYear = 2026, calMonth = 9;
        function renderCalendar() {
          var monthSelect = document.querySelector('select[title="Change the month"]');
          var yearSelect = document.querySelector('select[title="Change the year"]');
          var monthHtml = '';
          for (var i = 0; i < 12; i++) {
            monthHtml += '<option value="' + (i + 1) + '/' + calYear + '"' + (i === calMonth ? ' selected' : '') + '>' + MONTHS[i] + '</option>';
          }
          monthSelect.innerHTML = monthHtml;
          var yearHtml = '';
          for (var y = 1926; y <= 2040; y++) {
            yearHtml += '<option value="' + (calMonth + 1) + '/' + y + '"' + (y === calYear ? ' selected' : '') + '>' + y + '</option>';
          }
          yearSelect.innerHTML = yearHtml;
          var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
          var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
          var daysDiv = document.getElementById('calendarDays');
          var html = '';
          for (var d = 1; d <= daysInMonth; d++) {
            var dow = dayNames[new Date(calYear, calMonth, d).getDay()];
            html += '<a href="javascript:void(0)" class="dp' + d + '" title="Select ' + dow + ', ' + ABBR[calMonth] + ' ' + d + ', ' + calYear + '">' + d + '</a>';
          }
          daysDiv.innerHTML = html;
          var links = daysDiv.querySelectorAll('a');
          for (var j = 0; j < links.length; j++) {
            links[j].addEventListener('click', (function(day) {
              return function() {
                var mm = String(calMonth + 1).padStart(2, '0');
                var dd = String(day).padStart(2, '0');
                document.getElementById('DateOfBirth').value = dd + '/' + mm + '/' + calYear;
                document.getElementById('calendarPopup').style.display = 'none';
              };
            })(j + 1));
          }
        }
        document.querySelector('select[title="Change the month"]').addEventListener('change', function(e) {
          var parts = e.target.value.split('/');
          calMonth = Number(parts[0]) - 1; calYear = Number(parts[1]);
          renderCalendar();
        });
        document.querySelector('select[title="Change the year"]').addEventListener('change', function(e) {
          var parts = e.target.value.split('/');
          calMonth = Number(parts[0]) - 1; calYear = Number(parts[1]);
          renderCalendar();
        });
        document.getElementById('DateOfBirth').addEventListener('click', function() {
          document.getElementById('calendarPopup').style.display = 'block';
          renderCalendar();
        });
      })();
    </script>
  `);
}

/**
 * Package 5.46: RESUMED batch -- the operator's page is ALREADY on some
 * applicant's own Page 3 (no dashboard, no "APPLY FOR GROUP" button at
 * all in this fixture) -- exactly what a real resumed session looks like
 * after an earlier run's group creation already succeeded. If
 * visaStartSubmissionCommand ever mistakenly tried to click
 * APPLY FOR GROUP here, Playwright would time out looking for text that
 * does not exist on this page -- this fixture's own ABSENCE of that
 * button is the test's real assertion mechanism, not just a log entry.
 */
async function setResumedApplicantFixture(): Promise<void> {
  await page.setContent(`
    <div id="applicantPage">
      ${APPLICANT_PAGE_HTML}
    </div>
    <script>
      window.__eventLog = [];
      document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
      });
      document.getElementById('fileInput').addEventListener('change', () => {
        document.getElementById('cropModal').style.display = 'block';
      });
      document.querySelector('#cropModal button.upload-result').addEventListener('click', () => {
        document.getElementById('cropModal').style.display = 'none';
      });

      // Calendar-widget fix: a hand-built stand-in for the real jQuery
      // "datepick"-family widget (see selectDateFromCalendarWidget's own
      // doc comment, visitSaudiPageActions.ts, for the full real
      // evidence this fixture mirrors).
      (function() {
        var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var calYear = 2026, calMonth = 9;
        function renderCalendar() {
          var monthSelect = document.querySelector('select[title="Change the month"]');
          var yearSelect = document.querySelector('select[title="Change the year"]');
          var monthHtml = '';
          for (var i = 0; i < 12; i++) {
            monthHtml += '<option value="' + (i + 1) + '/' + calYear + '"' + (i === calMonth ? ' selected' : '') + '>' + MONTHS[i] + '</option>';
          }
          monthSelect.innerHTML = monthHtml;
          var yearHtml = '';
          for (var y = 1926; y <= 2040; y++) {
            yearHtml += '<option value="' + (calMonth + 1) + '/' + y + '"' + (y === calYear ? ' selected' : '') + '>' + y + '</option>';
          }
          yearSelect.innerHTML = yearHtml;
          var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
          var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
          var daysDiv = document.getElementById('calendarDays');
          var html = '';
          for (var d = 1; d <= daysInMonth; d++) {
            var dow = dayNames[new Date(calYear, calMonth, d).getDay()];
            html += '<a href="javascript:void(0)" class="dp' + d + '" title="Select ' + dow + ', ' + ABBR[calMonth] + ' ' + d + ', ' + calYear + '">' + d + '</a>';
          }
          daysDiv.innerHTML = html;
          var links = daysDiv.querySelectorAll('a');
          for (var j = 0; j < links.length; j++) {
            links[j].addEventListener('click', (function(day) {
              return function() {
                var mm = String(calMonth + 1).padStart(2, '0');
                var dd = String(day).padStart(2, '0');
                document.getElementById('DateOfBirth').value = dd + '/' + mm + '/' + calYear;
                document.getElementById('calendarPopup').style.display = 'none';
              };
            })(j + 1));
          }
        }
        document.querySelector('select[title="Change the month"]').addEventListener('change', function(e) {
          var parts = e.target.value.split('/');
          calMonth = Number(parts[0]) - 1; calYear = Number(parts[1]);
          renderCalendar();
        });
        document.querySelector('select[title="Change the year"]').addEventListener('change', function(e) {
          var parts = e.target.value.split('/');
          calMonth = Number(parts[0]) - 1; calYear = Number(parts[1]);
          renderCalendar();
        });
        document.getElementById('DateOfBirth').addEventListener('click', function() {
          document.getElementById('calendarPopup').style.display = 'block';
          renderCalendar();
        });
      })();
    </script>
  `);
}

test('visaStartSubmissionCommand: STARTED -- with a real (injected, local) session and a real queued applicant, the full chain runs end-to-end, the applicant reaches AMBIGUOUS in the real DB (this project\'s own updated rule -- a resolved SAVE click is never, by itself, proof of a real save), and operatorSummaryText is populated', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { batchId, passportIdentityId } = await createActiveApplicant(groupId);
    await queueBatch(batchId, 'operator:setup');
    await setBatchFixture();

    const fakePreflight = async (_groupId: string, _passportIdentityId: string): Promise<VisitSaudiPreflightResult> => ({
      passportIdentityId,
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

    const outcome = await visaStartSubmissionCommand(
      { telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:x' },
      {
        ...defaultDependencies,
        getActiveSession: async () => ({ available: true, page, release: async () => undefined }),
        checkPreflight: fakePreflight,
      },
    );

    assert.equal(outcome.kind, 'STARTED');
    if (outcome.kind !== 'STARTED') throw new Error('unreachable');
    assert.match(outcome.operatorSummaryText, /1-o'rin: AMBIGUOUS/);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM visa_submission_queue WHERE batch_id = $1', [batchId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'AMBIGUOUS');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStartSubmissionCommand: STARTED releases the session (release() called) exactly once, even on success, so a CDP-based connection never leaks across commands', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { batchId, passportIdentityId } = await createActiveApplicant(groupId);
    await queueBatch(batchId, 'operator:setup');
    await setBatchFixture();

    const fakePreflight = async (_groupId: string, _passportIdentityId: string): Promise<VisitSaudiPreflightResult> => ({
      passportIdentityId,
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

    let releaseCallCount = 0;
    const outcome = await visaStartSubmissionCommand(
      { telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:x' },
      {
        ...defaultDependencies,
        getActiveSession: async () => ({
          available: true,
          page,
          release: async () => {
            releaseCallCount += 1;
          },
        }),
        checkPreflight: fakePreflight,
      },
    );

    assert.equal(outcome.kind, 'STARTED');
    assert.equal(releaseCallCount, 1, 'release() must be called exactly once, so the CDP connection is never left open across commands');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStartSubmissionCommand: RESUMED batch -- when one queue row is already past PENDING (a prior partial run), group creation is correctly skipped and only the remaining PENDING applicant is processed', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    await createActiveApplicant(groupId); // second applicant in the SAME batch (same group, same portal, batch still has room)
    await queueBatch(batchId, 'operator:setup');

    // Simulate "group creation + applicant #1 already succeeded in an
    // earlier run" by directly marking applicant #1's queue row SAVED --
    // exactly the real-world state after a tunnel drop mid-batch, with no
    // new DB column and no guessed business value, same direct-SQL-
    // manipulation convention this file already uses elsewhere.
    const {
      rows: [firstQueueRow, secondQueueRow],
    } = await pool.query<{ id: string }>(
      `SELECT q.id FROM visa_submission_queue q
       JOIN visa_batch_applicants a ON a.id = q.visa_batch_applicant_id
       WHERE q.batch_id = $1
       ORDER BY a.position_in_batch ASC`,
      [batchId],
    );
    assert.ok(firstQueueRow && secondQueueRow, 'expected exactly two queue rows after queueBatch');
    await pool.query(`UPDATE visa_submission_queue SET status = 'SAVED' WHERE id = $1`, [firstQueueRow.id]);

    // A resumed session's Chrome tab is already on an applicant's own
    // Page 3, NOT the dashboard -- setBatchFixture (with its dashboard +
    // APPLY FOR GROUP button) would be the WRONG fixture for this case.
    await setResumedApplicantFixture();

    const fakePreflight = async (_groupId: string, passportIdentityId: string): Promise<VisitSaudiPreflightResult> => ({
      passportIdentityId,
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

    const outcome = await visaStartSubmissionCommand(
      { telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:x' },
      {
        ...defaultDependencies,
        getActiveSession: async () => ({ available: true, page, release: async () => undefined }),
        checkPreflight: fakePreflight,
      },
    );

    assert.equal(outcome.kind, 'STARTED');

    const eventLog = await page.evaluate(() => (globalThis as unknown as { __eventLog: string[] }).__eventLog);
    assert.ok(
      !eventLog.includes('applyForGroup') && !eventLog.includes('confirmGroup'),
      `a RESUMED batch must never attempt group creation again -- eventLog was: ${JSON.stringify(eventLog)}`,
    );

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT q.id, q.status FROM visa_submission_queue q
       JOIN visa_batch_applicants a ON a.id = q.visa_batch_applicant_id
       WHERE q.batch_id = $1
       ORDER BY a.position_in_batch ASC`,
      [batchId],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, 'SAVED', 'the already-SAVED row from the prior run must remain untouched');
    // This project's own updated rule: a freshly-resolved SAVE click is
    // reported AMBIGUOUS, never SAVED (no reliable save-confirmation
    // signal exists yet) -- so the SECOND applicant, genuinely processed
    // by the real adapter during THIS run, reaches AMBIGUOUS, not SAVED.
    assert.equal(rows[1]?.status, 'AMBIGUOUS', 'the remaining PENDING applicant must now be processed and reach AMBIGUOUS');
  } finally {
    await cleanupAll([groupId]);
  }
});

test('visaStartSubmissionCommand: a batch with an AWAITING_MANUAL_CONTINUATION row (automation already filled Page 3/4 for one applicant, now waiting on a human) is correctly treated as already-started -- group creation is never attempted again', async () => {
  const { groupId, chatId } = await createGroup();
  try {
    const { batchId } = await createActiveApplicant(groupId);
    await createActiveApplicant(groupId); // second applicant in the SAME batch
    await queueBatch(batchId, 'operator:setup');

    const {
      rows: [firstQueueRow, secondQueueRow],
    } = await pool.query<{ id: string }>(
      `SELECT q.id FROM visa_submission_queue q
       JOIN visa_batch_applicants a ON a.id = q.visa_batch_applicant_id
       WHERE q.batch_id = $1
       ORDER BY a.position_in_batch ASC`,
      [batchId],
    );
    assert.ok(firstQueueRow && secondQueueRow, 'expected exactly two queue rows after queueBatch');
    // Package 5.?? Step 1: AWAITING_MANUAL_CONTINUATION, set directly via
    // SQL -- same convention as the sibling RESUMED-batch test above -- no
    // code path produces this status yet (the continuation command and
    // the automation's own Page-5 handoff are later, separate phases).
    await pool.query(`UPDATE visa_submission_queue SET status = 'AWAITING_MANUAL_CONTINUATION' WHERE id = $1`, [firstQueueRow.id]);

    await setResumedApplicantFixture();

    const fakePreflight = async (_groupId: string, passportIdentityId: string): Promise<VisitSaudiPreflightResult> => ({
      passportIdentityId,
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

    const outcome = await visaStartSubmissionCommand(
      { telegramChatId: chatId, authorStatus: 'administrator', requestedBy: 'operator:x' },
      {
        ...defaultDependencies,
        getActiveSession: async () => ({ available: true, page, release: async () => undefined }),
        checkPreflight: fakePreflight,
      },
    );

    assert.equal(outcome.kind, 'STARTED');

    const eventLog = await page.evaluate(() => (globalThis as unknown as { __eventLog: string[] }).__eventLog);
    assert.ok(
      !eventLog.includes('applyForGroup') && !eventLog.includes('confirmGroup'),
      `a batch with an AWAITING_MANUAL_CONTINUATION row must never attempt group creation again -- eventLog was: ${JSON.stringify(eventLog)}`,
    );

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT q.id, q.status FROM visa_submission_queue q
       JOIN visa_batch_applicants a ON a.id = q.visa_batch_applicant_id
       WHERE q.batch_id = $1
       ORDER BY a.position_in_batch ASC`,
      [batchId],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, 'AWAITING_MANUAL_CONTINUATION', 'the AWAITING_MANUAL_CONTINUATION row must remain untouched -- this phase never processes it');
    assert.equal(rows[1]?.status, 'AMBIGUOUS', 'the remaining PENDING applicant must still be processed normally');
  } finally {
    await cleanupAll([groupId]);
  }
});
