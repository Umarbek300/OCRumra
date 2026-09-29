-- Operator-triggered command queue for CANCEL_PASSPORT / MOVE_TO_GROUP /
-- REMOVE_FROM_GROUP (see the duplicate-passport design spec §G). Claimed
-- via the same single-statement atomic UPDATE ... WHERE status = 'pending'
-- ... RETURNING idiom already used by passport_processing/sheet_sync_queue
-- — no new claiming mechanism introduced.
--
-- Telegram has no message-deletion event for ordinary group/supergroup
-- chats (Bot API structural limitation) — every command here is an
-- explicit, human-issued business action, never inferred from Telegram
-- activity.
CREATE TYPE passport_operator_command_type AS ENUM ('cancel_passport', 'move_to_group', 'remove_from_group');
CREATE TYPE passport_operator_command_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE passport_operator_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_type passport_operator_command_type NOT NULL,
  passport_identity_id UUID NOT NULL REFERENCES passport_identity (id),
  -- Target group for cancel_passport/remove_from_group. NULL for
  -- move_to_group, which uses from_group_id/to_group_id instead.
  group_id UUID REFERENCES groups (id),
  from_group_id UUID REFERENCES groups (id),
  to_group_id UUID REFERENCES groups (id),
  -- The message the operator referenced when issuing the command —
  -- informational/traceability only, never re-derived or trusted blindly
  -- at processing time (processing MUST re-resolve current state fresh).
  telegram_message_id UUID REFERENCES telegram_messages (id),
  operator_id TEXT NOT NULL,
  status passport_operator_command_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT passport_operator_commands_shape_check CHECK (
    (command_type IN ('cancel_passport', 'remove_from_group') AND group_id IS NOT NULL
      AND from_group_id IS NULL AND to_group_id IS NULL)
    OR
    (command_type = 'move_to_group' AND group_id IS NULL
      AND from_group_id IS NOT NULL AND to_group_id IS NOT NULL)
  )
);

CREATE TRIGGER passport_operator_commands_set_updated_at
  BEFORE UPDATE ON passport_operator_commands
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_passport_operator_commands_pending ON passport_operator_commands (created_at) WHERE status = 'pending';
CREATE INDEX idx_passport_operator_commands_identity ON passport_operator_commands (passport_identity_id);

-- A row stuck in 'processing' past this many minutes is considered
-- abandoned (worker crash/restart mid-command) — same shape as
-- passport_processing/sheet_sync_queue's own stale-job recovery.
-- (Documented here for operator/DBA reference; the actual timeout
-- constant lives in the repository layer, same convention as
-- STALE_PROCESSING_TIMEOUT_MINUTES / STALE_SYNCING_TIMEOUT_MINUTES.)
