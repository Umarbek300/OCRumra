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

const CLAIMED_JOB: SheetSyncQueueRecord = {
  id: 'job-1',
  telegramMessageId: 'msg-1',
  status: 'syncing',
  attempts: 1,
  lastError: null,
  sheetRowNumber: null,
  nextAttemptAt: '2026-01-01T00:00:00.000Z',
  syncedAt: null,
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

interface Calls {
  markStarted: number;
  markSynced: number;
  markFailed: number;
  findTelegramMessage: number;
  findOcrResult: number;
  findAgent: number;
  ensureSheet: number;
  upsertRow: number;
}

interface BuildDepsOptions {
  telegramMessage?: TelegramMessageRecord | null;
  ocrResult?: PassportOcrResultRecord | null;
  agent?: Agent | null;
  claimResult?: SheetSyncQueueRecord | null;
  upsertRowImpl?: SyncPassportRowToSheetDependencies['upsertRow'];
}

function buildDeps(options: BuildDepsOptions = {}): { deps: SyncPassportRowToSheetDependencies; calls: Calls; syncedArgs: unknown[]; failedArgs: unknown[] } {
  const calls: Calls = {
    markStarted: 0,
    markSynced: 0,
    markFailed: 0,
    findTelegramMessage: 0,
    findOcrResult: 0,
    findAgent: 0,
    ensureSheet: 0,
    upsertRow: 0,
  };
  const syncedArgs: unknown[] = [];
  const failedArgs: unknown[] = [];

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
    findTelegramMessage: async () => {
      calls.findTelegramMessage += 1;
      return options.telegramMessage !== undefined ? options.telegramMessage : TELEGRAM_MESSAGE;
    },
    findOcrResult: async () => {
      calls.findOcrResult += 1;
      return options.ocrResult !== undefined ? options.ocrResult : OCR_RESULT;
    },
    findAgent: async () => {
      calls.findAgent += 1;
      return options.agent !== undefined ? options.agent : AGENT;
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
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };

  return { deps, calls, syncedArgs, failedArgs };
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

test('computeSheetSyncBackoff follows the deterministic schedule: 1min, 5min, 30min, 60min (capped)', () => {
  const now = () => new Date('2026-01-01T00:00:00.000Z');

  assert.equal(computeSheetSyncBackoff(1, now).getTime(), new Date('2026-01-01T00:01:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(2, now).getTime(), new Date('2026-01-01T00:05:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(3, now).getTime(), new Date('2026-01-01T00:30:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(4, now).getTime(), new Date('2026-01-01T01:00:00.000Z').getTime());
  assert.equal(computeSheetSyncBackoff(10, now).getTime(), new Date('2026-01-01T01:00:00.000Z').getTime(), 'caps at the last schedule entry, never grows unbounded');
});
