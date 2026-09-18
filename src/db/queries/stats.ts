import { pool } from '../pool.js';

export interface GroupStats {
  groupId: string;
  totalCustomers: number;
  menCount: number;
  womenCount: number;
}

export async function getGroupStats(groupId: string): Promise<GroupStats | null> {
  const { rows } = await pool.query(
    `SELECT group_id, total_customers, men_count, women_count
     FROM group_customer_stats WHERE group_id = $1`,
    [groupId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    groupId: row.group_id,
    totalCustomers: Number(row.total_customers),
    menCount: Number(row.men_count),
    womenCount: Number(row.women_count),
  };
}

export interface CustomerBalance {
  customerId: string;
  packagePrice: string;
  totalPaid: string;
  remainingBalance: string;
}

export async function getCustomerBalance(customerId: string): Promise<CustomerBalance | null> {
  const { rows } = await pool.query(
    `SELECT customer_id, package_price, total_paid, remaining_balance
     FROM customer_balances WHERE customer_id = $1`,
    [customerId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    customerId: row.customer_id,
    packagePrice: row.package_price,
    totalPaid: row.total_paid,
    remainingBalance: row.remaining_balance,
  };
}

export async function getGroupMoneyTotal(groupId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT total_received FROM group_money_totals WHERE group_id = $1`,
    [groupId],
  );
  return rows[0]?.total_received ?? '0';
}

export async function getMoneyReceivedToday(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT total_received FROM daily_money_totals WHERE payment_date = CURRENT_DATE`,
  );
  return rows[0]?.total_received ?? '0';
}

export interface AgentDailyTotal {
  agentId: string;
  totalReceived: string;
}

export async function getMoneyReceivedTodayByAgent(): Promise<AgentDailyTotal[]> {
  const { rows } = await pool.query(
    `SELECT agent_id, total_received FROM daily_agent_totals WHERE payment_date = CURRENT_DATE`,
  );
  return rows.map((row) => ({ agentId: row.agent_id, totalReceived: row.total_received }));
}
