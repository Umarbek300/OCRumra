import { pool } from '../pool.js';

export interface Agent {
  id: string;
  name: string;
  telegramUserId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  telegram_user_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function mapRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    telegramUserId: row.telegram_user_id,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findAgentByTelegramUserId(telegramUserId: number): Promise<Agent | null> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, name, telegram_user_id, is_active, created_at, updated_at
     FROM agents WHERE telegram_user_id = $1`,
    [telegramUserId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findAgentById(id: string): Promise<Agent | null> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, name, telegram_user_id, is_active, created_at, updated_at
     FROM agents WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function listAgents(): Promise<Agent[]> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, name, telegram_user_id, is_active, created_at, updated_at
     FROM agents ORDER BY name`,
  );
  return rows.map(mapRow);
}
