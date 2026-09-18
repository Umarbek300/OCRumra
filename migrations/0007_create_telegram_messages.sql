-- Raw Telegram photo-message events, before OCR/AI processing.
-- group_id / agent_id are nullable: a message is recorded even when the
-- Telegram chat or sender is not yet registered in the system ("unlinked").
-- We never guess or auto-create Groups/Agents from an inbound message.
CREATE TABLE telegram_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL,
  telegram_message_id BIGINT NOT NULL,
  telegram_sender_user_id BIGINT NOT NULL,
  telegram_sender_display_name TEXT,
  message_timestamp TIMESTAMPTZ NOT NULL,
  telegram_photo_file_id TEXT NOT NULL,
  group_id UUID REFERENCES groups (id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX idx_telegram_messages_group_id ON telegram_messages (group_id);
CREATE INDEX idx_telegram_messages_agent_id ON telegram_messages (agent_id);
CREATE INDEX idx_telegram_messages_sender_user_id ON telegram_messages (telegram_sender_user_id);
CREATE INDEX idx_telegram_messages_unlinked ON telegram_messages (id)
  WHERE group_id IS NULL OR agent_id IS NULL;
