import { findGroupById } from '../db/repositories/groups.repo.js';
import { findPassportIdentityById } from '../db/repositories/passportIdentity.repo.js';
import {
  createCancelOrRemoveCommand,
  createMoveToGroupCommand,
  findPendingCommandMatching,
  type PassportOperatorCommandRecord,
} from '../db/repositories/passportOperatorCommands.repo.js';
import { findTelegramMessageById } from '../db/repositories/telegramMessages.repo.js';

export type SubmitOperatorCommandInput =
  | {
      commandType: 'cancel_passport' | 'remove_from_group';
      passportIdentityId: string;
      groupId: string;
      telegramMessageId: string | null;
      operatorId: string;
    }
  | {
      commandType: 'move_to_group';
      passportIdentityId: string;
      fromGroupId: string;
      toGroupId: string;
      telegramMessageId: string | null;
      operatorId: string;
    };

export interface SubmitOperatorCommandDependencies {
  findIdentity: typeof findPassportIdentityById;
  findGroup: typeof findGroupById;
  findTelegramMessage: typeof findTelegramMessageById;
  findPendingMatching: typeof findPendingCommandMatching;
  createCancelOrRemove: typeof createCancelOrRemoveCommand;
  createMoveToGroup: typeof createMoveToGroupCommand;
}

const defaultDependencies: SubmitOperatorCommandDependencies = {
  findIdentity: findPassportIdentityById,
  findGroup: findGroupById,
  findTelegramMessage: findTelegramMessageById,
  findPendingMatching: findPendingCommandMatching,
  createCancelOrRemove: createCancelOrRemoveCommand,
  createMoveToGroup: createMoveToGroupCommand,
};

export type SubmitOperatorCommandResult =
  | { outcome: 'inserted'; command: PassportOperatorCommandRecord }
  | { outcome: 'already_pending'; command: PassportOperatorCommandRecord };

/**
 * The production-safe entry point for CANCEL_PASSPORT / REMOVE_FROM_GROUP /
 * MOVE_TO_GROUP: validates the payload references real rows, then inserts
 * the command idempotently into passport_operator_commands (reusing an
 * already-pending identical command rather than inserting a duplicate).
 *
 * This function's ONLY write is that one INSERT (or none at all, on the
 * idempotent-match path) — it never touches passport_identity,
 * passport_message_links, or the Sheet itself. All actual state mutation
 * happens exclusively inside processPassportOperatorCommand.ts, driven by
 * runOperatorCommandLoop.ts's normal sequential polling/recovery. By
 * construction this can never race with or duplicate the processor's own
 * transactional work, and every submitted command is auditable via the
 * passport_operator_commands row itself (who/what/when) plus the
 * identity_split-style events the processor writes when it runs the command.
 */
export async function submitOperatorCommand(
  input: SubmitOperatorCommandInput,
  deps: SubmitOperatorCommandDependencies = defaultDependencies,
): Promise<SubmitOperatorCommandResult> {
  if (!input.operatorId || input.operatorId.trim() === '') {
    throw new Error('submitOperatorCommand: operatorId is required');
  }
  if (!input.passportIdentityId) {
    throw new Error('submitOperatorCommand: passportIdentityId is required');
  }

  const identity = await deps.findIdentity(input.passportIdentityId);
  if (!identity) {
    throw new Error(`submitOperatorCommand: passport identity ${input.passportIdentityId} not found`);
  }

  if (input.telegramMessageId) {
    const message = await deps.findTelegramMessage(input.telegramMessageId);
    if (!message) {
      throw new Error(`submitOperatorCommand: telegram message ${input.telegramMessageId} not found`);
    }
  }

  if (input.commandType === 'cancel_passport' || input.commandType === 'remove_from_group') {
    if (!input.groupId) {
      throw new Error(`submitOperatorCommand: ${input.commandType} requires groupId`);
    }
    const group = await deps.findGroup(input.groupId);
    if (!group) {
      throw new Error(`submitOperatorCommand: group ${input.groupId} not found`);
    }

    const existing = await deps.findPendingMatching(input.commandType, input.passportIdentityId, input.groupId, null, null);
    if (existing) {
      return { outcome: 'already_pending', command: existing };
    }

    const command = await deps.createCancelOrRemove({
      commandType: input.commandType,
      passportIdentityId: input.passportIdentityId,
      groupId: input.groupId,
      telegramMessageId: input.telegramMessageId,
      operatorId: input.operatorId,
    });
    return { outcome: 'inserted', command };
  }

  const moveInput = input as Extract<SubmitOperatorCommandInput, { commandType: 'move_to_group' }>;

  if (!moveInput.fromGroupId || !moveInput.toGroupId) {
    throw new Error('submitOperatorCommand: move_to_group requires fromGroupId and toGroupId');
  }
  if (moveInput.fromGroupId === moveInput.toGroupId) {
    throw new Error('submitOperatorCommand: move_to_group requires fromGroupId and toGroupId to differ');
  }

  const [fromGroup, toGroup] = await Promise.all([deps.findGroup(moveInput.fromGroupId), deps.findGroup(moveInput.toGroupId)]);
  if (!fromGroup) {
    throw new Error(`submitOperatorCommand: from-group ${moveInput.fromGroupId} not found`);
  }
  if (!toGroup) {
    throw new Error(`submitOperatorCommand: to-group ${moveInput.toGroupId} not found`);
  }

  const existing = await deps.findPendingMatching(
    'move_to_group',
    moveInput.passportIdentityId,
    null,
    moveInput.fromGroupId,
    moveInput.toGroupId,
  );
  if (existing) {
    return { outcome: 'already_pending', command: existing };
  }

  const command = await deps.createMoveToGroup({
    passportIdentityId: moveInput.passportIdentityId,
    fromGroupId: moveInput.fromGroupId,
    toGroupId: moveInput.toGroupId,
    telegramMessageId: moveInput.telegramMessageId,
    operatorId: moveInput.operatorId,
  });
  return { outcome: 'inserted', command };
}
