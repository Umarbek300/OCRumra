import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeSheetSyncBackoff,
  syncPassportRowToSheet,
  type SyncPassportRowToSheetDependencies,
} from '../src/sheets/syncPassportRowToSheet.js';
import { MAX_SHEET_SYNC_ATTEMPTS, type SheetSyncQueueRecord } from '../src/db/repositories/sheetSyncQueue.repo.js';
import type { TelegramMessageRecord } from '../src/db/repositories/telegramMessages.repo.js';
import type { PassportOcrResultRecord } from '../src/db/repositories/passportOcrResult.repo.js';
import type { Agent } from '../src/db/repositories/agents.repo.js';
import type { Group } from '../src/db/repositories/groups.repo.js';
import type { GroupGenderStats } from '../src/db/repositories/groupGenderStats.repo.js';

const CLAIMED_JOB: SheetSyncQueueRecord = {
  id: 'job-1',
  telegramMessageId: 'msg-1',
  status: 'syncing',
  attempts: 1,
  lastError: null,
  sheetRowNumber: null,
  nextAttemptAt: '2026-01-01T00:00:00.000Z',
  syncedAt: null,
  confirmationSentAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const TELEGRAM_MESSAGE: TelegramMessageRecord = {
  id: 'msg-1',
  telegramChatId: '-1001234567890',
  telegramMessageId: '42',
  telegramSenderUserId: '999',
  telegramSenderDisplayName: 'Sender',
  messageTimestamp: '2026-01-01T00:00:00.000Z',
  telegramPhotoFileId: 'FILE_ABC',
  source: 'photo',
  groupId: 'group-1',
  agentId: 'agent-1',
  captionText: null,
  mediaGroupId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function ocrField<T extends string = string>(value: T | null) {
  return { value, confidence: value ? ('high' as const) : null };
}

const OCR_RESULT: PassportOcrResultRecord = {
  id: 'ocr-1',
  telegramMessageId: 'msg-1',
  firstName: ocrField('ANNA'),
  middleName: ocrField(null),
  surname: ocrField('ERIKSSON'),
  passportNumber: ocrField('L898902C3'),
  dateOfBirth: ocrField('1974-08-12'),
  passportIssueDate: ocrField(null),
  passportExpiryDate: ocrField('2012-04-15'),
  gender: ocrField('female'),
  nationality: ocrField('UTO'),
  placeOfBirth: ocrField(null),
  issuingAuthority: ocrField(null),
  mrz: ocrField(null),
  overallConfidence: 'high',
  rawResponse: {},
  provider: 'google-vision',
  model: 'google-vision-mrz',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const AGENT: Agent = {
  id: 'agent-1',
  name: 'Jasur Agent',
  telegramUserId: '999',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const GROUP: Group = {
  id: 'group-1',
  name: '20 September',
  departureDate: '2026-09-20',
  telegramChatId: '-1001234567890',
  googleSheetId: 'sheet-abc',
  googleSheetGid: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ZERO_GENDER_STATS: GroupGenderStats = { male: 0, female: 0, unspecified: 0, total: 0 };

interface Calls {
  markStarted: number;
  markSynced: number;
  markFailed: number;
  findTelegramMessage: number;
  findOcrResult: number;
  findAgent: number;
  findGroup: number;
  ensureSheet: number;
  upsertRow: number;
  computeGenderStats: number;
  writeGenderSummary: number;
  markConfirmationSent: number;
  clearConfirmationSent: number;
  sendConfirmation: number;
}

interface BuildDepsOptions {
  telegramMessage?: TelegramMessageRecord | null;
  ocrResult?: PassportOcrResultRecord | null;
  agent?: Agent | null;
  group?: Group | null;
  genderStats?: GroupGenderStats;
  claimResult?: SheetSyncQueueRecord | null;
  upsertRowImpl?: SyncPassportRowToSheetDependencies['upsertRow'];
  writeGenderSummaryImpl?: SyncPassportRowToSheetDependencies['writeGenderSummary'];
  /** null simulates "a confirmation was already sent for this job" (the atomic claim losing/no-op). */
  confirmationClaimResult?: SheetSyncQueueRecord | null;
  sendConfirmationImpl?: SyncPassportRowToSheetDependencies['sendConfirmation'];
  messageLink?: Awaited<ReturnType<SyncPassportRowToSheetDependencies['findMessageLink']>>;
  activeCanonicalLink?: Awaited<ReturnType<SyncPassportRowToSheetDependencies['findActiveCanonicalLink']>>;
  /** id-aware override, for canonical-resolution tests that must return DIFFERENT records depending on which message id is looked up. */
  findTelegramMessageImpl?: SyncPassportRowToSheetDependencies['findTelegramMessage'];
  /** id-aware override, same reason as findTelegramMessageImpl. */
  findOcrResultImpl?: SyncPassportRowToSheetDependencies['findOcrResult'];
}

function buildDeps(options: BuildDepsOptions = {}): {
  deps: SyncPassportRowToSheetDependencies;
  calls: Calls;
  syncedArgs: unknown[];
  failedArgs: unknown[];
  sendConfirmationArgs: unknown[];
  writeGenderSummaryArgs: unknown[];
} {
  const calls: Calls = {
    markStarted: 0,
    markSynced: 0,
    markFailed: 0,
    findTelegramMessage: 0,
    findOcrResult: 0,
    findAgent: 0,
    findGroup: 0,
    ensureSheet: 0,
    upsertRow: 0,
    computeGenderStats: 0,
    writeGenderSummary: 0,
    markConfirmationSent: 0,
    clearConfirmationSent: 0,
    sendConfirmation: 0,
  };
  const syncedArgs: unknown[] = [];
  const failedArgs: unknown[] = [];
  const sendConfirmationArgs: unknown[] = [];
  const writeGenderSummaryArgs: unknown[] = [];

  const deps: SyncPassportRowToSheetDependencies = {
    markStarted: async () => {
      calls.markStarted += 1;
      return options.claimResult !== undefined ? options.claimResult : CLAIMED_JOB;
    },
    markSynced: async (id, sheetRowNumber) => {
      calls.markSynced += 1;
      syncedArgs.push({ id, sheetRowNumber });
      return { ...CLAIMED_JOB, status: 'synced', sheetRowNumber };
    },
    markFailed: async (id, errorMessage, nextAttemptAt) => {
      calls.markFailed += 1;
      failedArgs.push({ id, errorMessage, nextAttemptAt });
      return { ...CLAIMED_JOB, status: 'failed', lastError: errorMessage };
    },
    findTelegramMessage:
      options.findTelegramMessageImpl ??
      (async () => {
        calls.findTelegramMessage += 1;
        return options.telegramMessage !== undefined ? options.telegramMessage : TELEGRAM_MESSAGE;
      }),
    findOcrResult:
      options.findOcrResultImpl ??
      (async () => {
        calls.findOcrResult += 1;
        return options.ocrResult !== undefined ? options.ocrResult : OCR_RESULT;
      }),
    findAgent: async () => {
      calls.findAgent += 1;
      return options.agent !== undefined ? options.agent : AGENT;
    },
    findGroup: async () => {
      calls.findGroup += 1;
      return options.group !== undefined ? options.group : GROUP;
    },
    ensureSheet: async () => {
      calls.ensureSheet += 1;
      return { spreadsheetId: 'sheet-abc' };
    },
    upsertRow:
      options.upsertRowImpl ??
      (async () => {
        calls.upsertRow += 1;
        return { action: 'appended', rowNumber: 5 };
      }),
    computeGenderStats: async () => {
      calls.computeGenderStats += 1;
      return options.genderStats ?? ZERO_GENDER_STATS;
    },
    writeGenderSummary:
      options.writeGenderSummaryImpl ??
      (async (spreadsheetId, rows) => {
        calls.writeGenderSummary += 1;
        writeGenderSummaryArgs.push({ spreadsheetId, rows });
      }),
    markConfirmationSent: async (id) => {
      calls.markConfirmationSent += 1;
      if (options.confirmationClaimResult !== undefined) return options.confirmationClaimResult;
      return { ...CLAIMED_JOB, status: 'synced', confirmationSentAt: '2026-01-01T00:00:00.000Z' };
    },
    clearConfirmationSent: async () => {
      calls.clearConfirmationSent += 1;
    },
    sendConfirmation:
      options.sendConfirmationImpl ??
      (async (telegramChatId, text) => {
        calls.sendConfirmation += 1;
        sendConfirmationArgs.push({ telegramChatId, text });
      }),
    // Duplicate-passport canonical resolution (src/duplicates/) — defaults
    // to "no link" so every pre-existing test in this file keeps its
    // original pre-feature behavior (resolves to the job's own message)
    // exactly unchanged. Dedicated canonical-resolution behavior has its
    // own tests further down this file.
    findMessageLink: options.messageLink !== undefined ? async () => options.messageLink! : async () => null,
    findActiveCanonicalLink:
      options.activeCanonicalLink !== undefined ? async () => options.activeCanonicalLink! : async () => null,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };

  return { deps, calls, syncedArgs, failedArgs, sendConfirmationArgs, writeGenderSummaryArgs };
}

test('syncPassportRowToSheet: happy path syncs the row and marks the job synced', async () => {
  const { deps, calls, syncedArgs } = buildDeps();

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markStarted, 1);
  assert.equal(calls.findTelegramMessage, 1);
  assert.equal(calls.findOcrResult, 1);
  assert.equal(calls.findAgent, 1);
  assert.equal(calls.ensureSheet, 1);
  assert.equal(calls.markSynced, 1);
  assert.equal(calls.markFailed, 0);
  assert.deepEqual(syncedArgs[0], { id: 'job-1', sheetRowNumber: 5 });
});

// --- package/deposit/balance sourced from the Telegram message's caption ---
// These come ONLY from telegramMessage.captionText, never from the OCR
// result (see parsePackageDeposit.ts) — each test below captures the exact
// row array passed to upsertRow to verify columns J/K/L (indices 9/10/11).

test('syncPassportRowToSheet parses package/deposit from the caption and writes the computed balance into columns J/K/L', async () => {
  let capturedRow: readonly string[] | null = null;
  const { deps } = buildDeps({
    telegramMessage: { ...TELEGRAM_MESSAGE, captionText: 'Package: Standard $1400\nDeposit: $200' },
    upsertRowImpl: async (input) => {
      capturedRow = input.row;
      return { action: 'appended', rowNumber: 5 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.ok(capturedRow);
  assert.equal(capturedRow![9], '$1400', 'Paket (J)');
  assert.equal(capturedRow![10], '$200', 'Depozit (K)');
  assert.equal(capturedRow![11], '$1200', 'Qoldiq (L) = package - deposit');
});

test('syncPassportRowToSheet leaves Paket/Depozit/Qoldiq empty when the message has no caption at all', async () => {
  let capturedRow: readonly string[] | null = null;
  const { deps } = buildDeps({
    telegramMessage: { ...TELEGRAM_MESSAGE, captionText: null },
    upsertRowImpl: async (input) => {
      capturedRow = input.row;
      return { action: 'appended', rowNumber: 5 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.ok(capturedRow);
  assert.equal(capturedRow![9], '');
  assert.equal(capturedRow![10], '');
  assert.equal(capturedRow![11], '');
});

test('syncPassportRowToSheet writes Paket but leaves Depozit/Qoldiq empty when only a package amount is present in the caption', async () => {
  let capturedRow: readonly string[] | null = null;
  const { deps } = buildDeps({
    telegramMessage: { ...TELEGRAM_MESSAGE, captionText: 'Package: Standard $1400' },
    upsertRowImpl: async (input) => {
      capturedRow = input.row;
      return { action: 'appended', rowNumber: 5 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.ok(capturedRow);
  assert.equal(capturedRow![9], '$1400');
  assert.equal(capturedRow![10], '');
  assert.equal(capturedRow![11], '', 'no balance without a reliable deposit amount too');
});

test('syncPassportRowToSheet never lets package/deposit parsing affect the passport OCR fields written to the row', async () => {
  let capturedRow: readonly string[] | null = null;
  const { deps } = buildDeps({
    telegramMessage: { ...TELEGRAM_MESSAGE, captionText: 'Package: Standard $1400\nDeposit: $200' },
    upsertRowImpl: async (input) => {
      capturedRow = input.row;
      return { action: 'appended', rowNumber: 5 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.ok(capturedRow);
  assert.equal(capturedRow![1], 'ANNA', 'Ism');
  assert.equal(capturedRow![2], 'ERIKSSON', 'Familiya');
  assert.equal(capturedRow![3], 'L898902C3', 'Passport №');
});

test('syncPassportRowToSheet does nothing further when the job could not be claimed', async () => {
  const { deps, calls } = buildDeps({ claimResult: null });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markStarted, 1);
  assert.equal(calls.findTelegramMessage, 0);
  assert.equal(calls.markSynced, 0);
  assert.equal(calls.markFailed, 0);
});

test('syncPassportRowToSheet marks the job failed with a clear message when the telegram_message is missing', async () => {
  const { deps, calls, failedArgs } = buildDeps({ telegramMessage: null });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markFailed, 1);
  assert.equal(calls.markSynced, 0);
  const call = failedArgs[0] as { errorMessage: string };
  assert.match(call.errorMessage, /telegram_message msg-1 not found/);
});

test('syncPassportRowToSheet marks the job failed when the telegram_message has no group_id', async () => {
  const { deps, failedArgs } = buildDeps({ telegramMessage: { ...TELEGRAM_MESSAGE, groupId: null } });

  await syncPassportRowToSheet('job-1', deps);

  const call = failedArgs[0] as { errorMessage: string };
  assert.match(call.errorMessage, /no group_id/);
});

test('syncPassportRowToSheet marks the job failed (safely, clearly) when no OCR result exists yet', async () => {
  const { deps, calls, failedArgs } = buildDeps({ ocrResult: null });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.ensureSheet, 0, 'must not touch Sheets at all if there is nothing to sync');
  const call = failedArgs[0] as { errorMessage: string };
  assert.match(call.errorMessage, /no passport_ocr_results row/);
});

test('syncPassportRowToSheet never looks up an agent when the message has no agentId', async () => {
  const { deps, calls } = buildDeps({ telegramMessage: { ...TELEGRAM_MESSAGE, agentId: null } });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.findAgent, 0);
  assert.equal(calls.markSynced, 1, 'still syncs successfully with no agent');
});

test('syncPassportRowToSheet marks the job failed and schedules a backoff retry when the Sheets write itself fails', async () => {
  const { deps, calls, failedArgs } = buildDeps({
    upsertRowImpl: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markSynced, 0);
  assert.equal(calls.markFailed, 1);
  const call = failedArgs[0] as { errorMessage: string; nextAttemptAt: Date };
  assert.match(call.errorMessage, /quota exceeded/);
  assert.equal(call.nextAttemptAt.getTime(), new Date('2026-01-01T00:01:00.000Z').getTime(), 'attempts=1 -> 1 minute backoff');
});

test('syncPassportRowToSheet logs a distinct, clear "permanently failed" message once markFailed reports attempts reaching MAX_SHEET_SYNC_ATTEMPTS', async () => {
  const { deps } = buildDeps({
    upsertRowImpl: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
    // markFailed below is overridden to report the row's true attempts —
    // in real use this is markSheetSyncStarted's own count, carried
    // through; here we just need markFailed's return value to reflect it.
  });
  deps.markFailed = async (id, errorMessage, nextAttemptAt) => ({
    ...CLAIMED_JOB,
    status: 'failed',
    lastError: errorMessage,
    attempts: MAX_SHEET_SYNC_ATTEMPTS,
    nextAttemptAt: (nextAttemptAt ?? new Date()).toISOString(),
  });

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await syncPassportRowToSheet('job-1', deps);
  } finally {
    console.error = originalError;
  }

  const combined = logged.join('\n');
  assert.match(combined, /permanently failed/);
  assert.match(combined, new RegExp(`${MAX_SHEET_SYNC_ATTEMPTS}/${MAX_SHEET_SYNC_ATTEMPTS}`));
  assert.match(combined, /will NOT be retried automatically/);
  assert.match(combined, /quota exceeded/, 'the sanitized error text is still included for the operator, not swallowed');
});

test('syncPassportRowToSheet logs a normal "will retry" message (not "permanently failed") while attempts remain below the max', async () => {
  const { deps } = buildDeps({
    upsertRowImpl: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
  });
  // Default markFailed mock returns attempts: 1 (CLAIMED_JOB's fixed value) — well below MAX_SHEET_SYNC_ATTEMPTS.

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await syncPassportRowToSheet('job-1', deps);
  } finally {
    console.error = originalError;
  }

  const combined = logged.join('\n');
  assert.match(combined, /will retry/);
  assert.ok(!combined.includes('permanently failed'));
});

test('syncPassportRowToSheet treats a Google API request timeout exactly like any other Sheets failure: failed + backoff retry, worker unaffected', async () => {
  // Simulates the shape gaxios/AbortSignal.timeout() produces when a
  // request is aborted for exceeding GOOGLE_SHEETS_API_TIMEOUT_MS — a
  // rejected promise, same as any other network error. syncPassportRowToSheet
  // deliberately has no timeout-specific branch: any upsertRow rejection
  // (quota, auth, network, or timeout) already flows through the exact
  // same catch -> markFailed + backoff path, which is the point of this test.
  const { deps, calls, failedArgs } = buildDeps({
    upsertRowImpl: async () => {
      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markSynced, 0, 'a timed-out write must never be recorded as synced');
  assert.equal(calls.markFailed, 1);
  const call = failedArgs[0] as { errorMessage: string; nextAttemptAt: Date };
  assert.match(call.errorMessage, /timeout/i);
  assert.equal(
    call.nextAttemptAt.getTime(),
    new Date('2026-01-01T00:01:00.000Z').getTime(),
    'a timeout gets the same deterministic backoff as any other failure (attempts=1 -> 1 minute)',
  );
});

test('syncPassportRowToSheet never logs raw OCR/passport field values on failure', async () => {
  const { deps } = buildDeps({
    upsertRowImpl: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
  });

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await syncPassportRowToSheet('job-1', deps);
  } finally {
    console.error = originalError;
  }

  const combined = logged.join('\n');
  assert.ok(!combined.includes('ANNA'));
  assert.ok(!combined.includes('ERIKSSON'));
  assert.ok(!combined.includes('L898902C3'));
});

// --- Telegram confirmation ---

test('syncPassportRowToSheet sends exactly one confirmation, after markSynced, to the message\'s own chat', async () => {
  const { deps, calls, sendConfirmationArgs } = buildDeps();

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markConfirmationSent, 1);
  assert.equal(calls.sendConfirmation, 1);
  assert.equal(calls.markSynced, 1);
  const args = sendConfirmationArgs[0] as { telegramChatId: string; text: string };
  assert.equal(args.telegramChatId, TELEGRAM_MESSAGE.telegramChatId);
  assert.match(args.text, /Passport qabul qilindi/);
  assert.match(args.text, /qator №5/);
});

test('syncPassportRowToSheet never sends a confirmation when the Sheets write itself fails', async () => {
  const { deps, calls } = buildDeps({
    upsertRowImpl: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markSynced, 0);
  assert.equal(calls.markConfirmationSent, 0, 'must never even attempt to claim/send a confirmation for a job that never synced');
  assert.equal(calls.sendConfirmation, 0);
});

test('syncPassportRowToSheet skips sending when the confirmation claim reports it was already sent (duplicate-prevention)', async () => {
  const { deps, calls } = buildDeps({ confirmationClaimResult: null });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markSynced, 1, 'the sheet sync itself still succeeds and is recorded');
  assert.equal(calls.markConfirmationSent, 1, 'still attempts the atomic claim...');
  assert.equal(calls.sendConfirmation, 0, '...but sends nothing once the claim reports it lost/already-sent');
});

test('syncPassportRowToSheet rolls back the confirmation claim and does not affect job status when the Telegram send itself throws', async () => {
  const { deps, calls } = buildDeps({
    sendConfirmationImpl: async () => {
      throw new Error('Telegram API error: bot was blocked by the user');
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markSynced, 1, 'the job is still recorded as synced — a notification failure must never look like a Sheets failure');
  assert.equal(calls.markFailed, 0, 'must never flip an already-synced job back to failed just because the confirmation send failed');
  assert.equal(calls.clearConfirmationSent, 1, 'rolls back the claim so a later attempt could still try again');
});

test('syncPassportRowToSheet never logs raw OCR/passport field values when the confirmation send fails', async () => {
  const { deps } = buildDeps({
    sendConfirmationImpl: async () => {
      throw new Error('Telegram API error: bot was blocked by the user');
    },
  });

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await syncPassportRowToSheet('job-1', deps);
  } finally {
    console.error = originalError;
  }

  const combined = logged.join('\n');
  assert.ok(!combined.includes('ANNA'));
  assert.ok(!combined.includes('ERIKSSON'));
  assert.ok(!combined.includes('L898902C3'));
});

// --- group gender summary (O1:P5) ---

test('syncPassportRowToSheet recomputes the group gender summary and writes it after a successful sync', async () => {
  const stats: GroupGenderStats = { male: 3, female: 2, unspecified: 1, total: 6 };
  const { deps, calls, writeGenderSummaryArgs } = buildDeps({ genderStats: stats });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.findGroup, 1);
  assert.equal(calls.computeGenderStats, 1);
  assert.equal(calls.writeGenderSummary, 1);
  const args = writeGenderSummaryArgs[0] as { spreadsheetId: string; rows: string[][] };
  assert.equal(args.spreadsheetId, 'sheet-abc');
  assert.deepEqual(args.rows, [
    [`Guruh: ${GROUP.name} — ${GROUP.departureDate}`, ''],
    ['Jami:', '6'],
    ['Erkak:', '3'],
    ['Ayol:', '2'],
    ["Noma'lum:", '1'],
  ]);
});

test('syncPassportRowToSheet never updates the gender summary when the Sheets write itself fails', async () => {
  const { deps, calls } = buildDeps({
    upsertRowImpl: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markSynced, 0);
  assert.equal(calls.computeGenderStats, 0, 'must never even compute a summary for a job that never synced');
  assert.equal(calls.writeGenderSummary, 0);
});

test('a gender summary write failure never flips an already-synced job back to failed', async () => {
  const { deps, calls } = buildDeps({
    writeGenderSummaryImpl: async () => {
      throw new Error('Google Sheets API error: quota exceeded');
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.markSynced, 1, 'the job is still recorded as synced — a summary failure must never look like a Sheets failure');
  assert.equal(calls.markFailed, 0);
});

test('syncPassportRowToSheet recomputing the summary on a retry/re-sync never double-counts — it is always a fresh overwrite of the same fixed range', async () => {
  const stats: GroupGenderStats = { male: 5, female: 4, unspecified: 0, total: 9 };
  const { deps, calls, writeGenderSummaryArgs } = buildDeps({ genderStats: stats });

  await syncPassportRowToSheet('job-1', deps);
  await syncPassportRowToSheet('job-1', deps);

  // Each call recomputes independently; both calls see the SAME live total
  // because nothing is ever incremented, so two calls never sum to double.
  assert.equal(calls.computeGenderStats, 2);
  assert.equal(writeGenderSummaryArgs.length, 2);
  const [first, second] = writeGenderSummaryArgs as Array<{ rows: string[][] }>;
  assert.deepEqual(first!.rows, second!.rows, 'identical fresh recompute both times, never a running sum');
});

// --- duplicate-passport canonical resolution (src/duplicates/) ---

test('syncPassportRowToSheet writes to the CANONICAL message id when this job is an auto-merged duplicate', async () => {
  const CANONICAL_MESSAGE: TelegramMessageRecord = {
    ...TELEGRAM_MESSAGE,
    id: 'msg-canonical',
    captionText: 'Package: $1400',
  };
  const CANONICAL_OCR_RESULT: PassportOcrResultRecord = { ...OCR_RESULT, telegramMessageId: 'msg-canonical' };

  const upsertArgs: unknown[] = [];
  const { deps, calls } = buildDeps({
    messageLink: {
      id: 'link-1',
      passportIdentityId: 'identity-1',
      telegramMessageId: 'msg-1',
      groupId: 'group-1',
      agentId: 'agent-1',
      role: 'duplicate',
      linkStatus: 'active',
      matchConfidenceTier: 'high',
      resolvedBy: 'auto',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    activeCanonicalLink: {
      id: 'link-canonical',
      passportIdentityId: 'identity-1',
      telegramMessageId: 'msg-canonical',
      groupId: 'group-1',
      agentId: 'agent-1',
      role: 'canonical',
      linkStatus: 'active',
      matchConfidenceTier: 'new_identity',
      resolvedBy: 'auto',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    findTelegramMessageImpl: async (id: string) => (id === 'msg-canonical' ? CANONICAL_MESSAGE : TELEGRAM_MESSAGE),
    findOcrResultImpl: async (id: string) => (id === 'msg-canonical' ? CANONICAL_OCR_RESULT : OCR_RESULT),
    upsertRowImpl: async (input) => {
      calls.upsertRow += 1;
      upsertArgs.push(input);
      return { action: 'updated', rowNumber: 3 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.upsertRow, 1);
  assert.equal((upsertArgs[0] as { telegramMessageId: string }).telegramMessageId, 'msg-canonical');
});

test('syncPassportRowToSheet sends the confirmation to the ORIGINAL message\'s own chat even when the row content is canonical', async () => {
  const CANONICAL_MESSAGE: TelegramMessageRecord = { ...TELEGRAM_MESSAGE, id: 'msg-canonical', telegramChatId: 'CANONICAL_CHAT' };
  const { deps, sendConfirmationArgs } = buildDeps({
    messageLink: {
      id: 'link-1',
      passportIdentityId: 'identity-1',
      telegramMessageId: 'msg-1',
      groupId: 'group-1',
      agentId: 'agent-1',
      role: 'duplicate',
      linkStatus: 'active',
      matchConfidenceTier: 'high',
      resolvedBy: 'auto',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    activeCanonicalLink: {
      id: 'link-canonical',
      passportIdentityId: 'identity-1',
      telegramMessageId: 'msg-canonical',
      groupId: 'group-1',
      agentId: 'agent-1',
      role: 'canonical',
      linkStatus: 'active',
      matchConfidenceTier: 'new_identity',
      resolvedBy: 'auto',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    findTelegramMessageImpl: async (id: string) => (id === 'msg-canonical' ? CANONICAL_MESSAGE : TELEGRAM_MESSAGE),
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal((sendConfirmationArgs[0] as { telegramChatId: string }).telegramChatId, TELEGRAM_MESSAGE.telegramChatId);
});

test('syncPassportRowToSheet with no passport_message_links row resolves to its own message id (pre-feature behavior exactly preserved)', async () => {
  const upsertArgs: unknown[] = [];
  const { deps, calls } = buildDeps({
    upsertRowImpl: async (input) => {
      calls.upsertRow += 1;
      upsertArgs.push(input);
      return { action: 'appended', rowNumber: 5 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal((upsertArgs[0] as { telegramMessageId: string }).telegramMessageId, 'msg-1');
});

test('computeSheetSyncBackoff follows the deterministic schedule: 1min, 5min, 30min, 60min (capped)', () => {
  const now = () => new Date('2026-01-01T00:00:00.000Z');

  assert.equal(computeSheetSyncBackoff(1, now).getTime(), new Date('2026-01-01T00:01:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(2, now).getTime(), new Date('2026-01-01T00:05:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(3, now).getTime(), new Date('2026-01-01T00:30:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(4, now).getTime(), new Date('2026-01-01T01:00:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(10, now).getTime(), new Date('2026-01-01T01:00:00.000Z').getTime(), 'caps at the last schedule entry, never grows unbounded');
});

// --- googleSheetGid data-flow (master/tab architecture) ---

test('A: a legacy group (googleSheetGid null) passes googleSheetGid: null through to upsertRow, unchanged behavior', async () => {
  let seenInput: unknown;
  const { deps } = buildDeps({
    group: { ...GROUP, googleSheetGid: null },
    upsertRowImpl: async (input) => {
      seenInput = input;
      return { action: 'appended', rowNumber: 5 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal((seenInput as { googleSheetGid: number | null }).googleSheetGid, null);
});

test('B: a master/tab group passes its exact googleSheetGid through to upsertRow', async () => {
  let seenInput: unknown;
  const { deps } = buildDeps({
    group: { ...GROUP, googleSheetGid: 918273645 },
    upsertRowImpl: async (input) => {
      seenInput = input;
      return { action: 'appended', rowNumber: 5 };
    },
  });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal((seenInput as { googleSheetGid: number | null }).googleSheetGid, 918273645);
});

test('findGroup is called exactly once per sync, reused for both upsertRow and the gender summary (no redundant DB call)', async () => {
  const { deps, calls } = buildDeps({ group: { ...GROUP, googleSheetGid: 111 } });

  await syncPassportRowToSheet('job-1', deps);

  assert.equal(calls.findGroup, 1);
  assert.equal(calls.writeGenderSummary, 1, 'the gender summary still gets written, using the same already-fetched group');
});
