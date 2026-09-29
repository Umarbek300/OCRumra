import { createGroup, findGroupByTelegramChatId, type Group } from '../db/repositories/groups.repo.js';
import { createPassportProcessingRecord } from '../db/repositories/passportProcessing.repo.js';
import { findUnlinkedMessagesByTelegramChatId, linkTelegramMessageToGroup } from '../db/repositories/telegramMessages.repo.js';
import { enqueuePassportProcessing } from '../queue/passportProcessingQueue.js';
import { parseDepartureDateFromGroupTitle } from './parseDepartureDateFromGroupTitle.js';

export interface EnsureGroupRegisteredDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  createGroup: typeof createGroup;
  findUnlinked: typeof findUnlinkedMessagesByTelegramChatId;
  linkMessage: typeof linkTelegramMessageToGroup;
  createProcessingRecord: typeof createPassportProcessingRecord;
  enqueueProcessing: typeof enqueuePassportProcessing;
}

const defaultDependencies: EnsureGroupRegisteredDependencies = {
  findGroup: findGroupByTelegramChatId,
  createGroup,
  findUnlinked: findUnlinkedMessagesByTelegramChatId,
  linkMessage: linkTelegramMessageToGroup,
  createProcessingRecord: createPassportProcessingRecord,
  enqueueProcessing: enqueuePassportProcessing,
};

/**
 * Backfills previously-unlinked messages for ONE chat once its group is
 * known -- patches group_id, then (mirroring ingestPhotoMessage.ts's own
 * linked-insert branch exactly) creates a passport_processing record and
 * enqueues it for OCR, but ONLY for a message whose agent_id is already
 * set (a message unlinked because its AGENT is still unregistered stays
 * exactly that way -- this function only ever fixes the GROUP side).
 *
 * Idempotent and safe to call repeatedly / concurrently for the same chat:
 * findUnlinked only ever returns rows still missing a group_id,
 * linkMessage only patches a row still NULL (a second sweep, or a
 * concurrent one, simply finds nothing left to do), and
 * createPassportProcessingRecord's own UNIQUE(telegram_message_id) means a
 * message that already has a processing record (e.g. an earlier sweep
 * that crashed after linking but before enqueueing) is never given a
 * second one -- it's simply skipped here without a duplicate enqueue.
 *
 * A transient Redis failure here is not fatal and not silently lost: the
 * passport_processing row is already durably 'queued' in Postgres, and
 * passportWorker.ts's existing stale-queued-job reconciliation (already
 * running for the ordinary ingest path) will pick it up on its own next
 * pass -- no new recovery mechanism needed here, same as
 * ingestPhotoMessage.ts's own enqueue try/catch.
 */
export async function backfillUnlinkedMessagesForGroup(
  telegramChatId: number,
  groupId: string,
  deps: EnsureGroupRegisteredDependencies = defaultDependencies,
): Promise<number> {
  const unlinked = await deps.findUnlinked(telegramChatId);
  let backfilled = 0;

  for (const message of unlinked) {
    const linked = await deps.linkMessage(message.id, groupId);
    if (!linked) {
      continue; // already linked by a concurrent sweep -- safe no-op
    }
    backfilled += 1;

    if (!linked.agentId) {
      continue; // still missing its agent link -- not this function's job to fix
    }

    const processingRecord = await deps.createProcessingRecord(linked.id);
    if (!processingRecord) {
      continue; // already has one -- an earlier sweep got this far already
    }
    try {
      await deps.enqueueProcessing(processingRecord.telegramMessageId);
    } catch (error) {
      console.error(
        `Failed to enqueue backfilled passport processing for telegram_message=${processingRecord.telegramMessageId}; ` +
          'record remains status=queued in Postgres for later recovery',
        error,
      );
    }
  }

  return backfilled;
}

export interface EnsureGroupRegisteredResult {
  group: Group | null;
  backfilledMessageCount: number;
}

/**
 * Resolves (and, when safely possible, auto-creates) the Group for a
 * Telegram chat -- the entry point ingestPhotoMessage.ts now calls instead
 * of a plain findGroupByTelegramChatId lookup.
 *
 * telegram_chat_id is the SOLE identity: an already-registered group's
 * name/departure_date are never touched here, no matter what the current
 * Telegram title says (see groups.repo.ts's own createGroup doc comment).
 *
 * Auto-creation only ever happens from a confidently, exactly parsed
 * title (see parseDepartureDateFromGroupTitle.ts) -- never a guess. A
 * title that doesn't parse (or is missing) leaves the group unresolved,
 * exactly the same outcome as before this feature existed: the message
 * gets recorded unlinked, and a human can register the group via
 * src/admin/registerGroup.ts as always.
 *
 * Deliberately never calls ensureGroupSheet -- a freshly created group's
 * google_sheet_id stays NULL; the existing syncPassportRowToSheet ->
 * ensureGroupSheet pipeline provisions it lazily and race-safely, the
 * first time any message for this group actually needs to sync. Nothing
 * here ever touches Google Sheets.
 *
 * Whenever a group is resolved -- whether just-created, or already
 * existing (covering a group that predates this feature but still has
 * orphaned unlinked messages, e.g. via a manual registerGroup.ts run) --
 * sweeps and backfills any of that chat's messages still missing a
 * group_id. Race-safe: if two ingests for the same brand-new chat race,
 * createGroup's own ON CONFLICT DO NOTHING lets only one create the row;
 * the loser re-reads the winner instead of creating a second one, and
 * both converge on the same backfill sweep target.
 */
export async function ensureGroupRegistered(
  telegramChatId: number,
  chatTitle: string | null,
  deps: EnsureGroupRegisteredDependencies = defaultDependencies,
): Promise<EnsureGroupRegisteredResult> {
  const existing = await deps.findGroup(telegramChatId);
  if (existing) {
    const backfilledMessageCount = await backfillUnlinkedMessagesForGroup(telegramChatId, existing.id, deps);
    return { group: existing, backfilledMessageCount };
  }

  const parsed = parseDepartureDateFromGroupTitle(chatTitle);
  if (!parsed || !chatTitle) {
    console.warn(
      `ensureGroupRegistered: cannot auto-register group for chat=${telegramChatId} -- ` +
        `title ${chatTitle === null ? 'is missing' : `"${chatTitle}" does not match a supported departure-date format`}; ` +
        'message(s) stay unlinked until a human registers this group (npm run admin:register-group)',
    );
    return { group: null, backfilledMessageCount: 0 };
  }

  const created = await deps.createGroup(chatTitle, parsed.date, telegramChatId);
  if (created) {
    console.log(
      `ensureGroupRegistered: auto-registered new group chat=${telegramChatId} name="${chatTitle}" departureDate=${parsed.date}`,
    );
    const backfilledMessageCount = await backfillUnlinkedMessagesForGroup(telegramChatId, created.id, deps);
    return { group: created, backfilledMessageCount };
  }

  // Lost a race to a concurrent auto-registration for the SAME chat --
  // converge on the winner instead of creating a second row.
  const winner = await deps.findGroup(telegramChatId);
  if (!winner) {
    throw new Error(`ensureGroupRegistered: lost the group-creation race for chat=${telegramChatId} but no winning row was found`);
  }
  const backfilledMessageCount = await backfillUnlinkedMessagesForGroup(telegramChatId, winner.id, deps);
  return { group: winner, backfilledMessageCount };
}
