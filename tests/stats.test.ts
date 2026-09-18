import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  getCustomerBalance,
  getGroupMoneyTotal,
  getGroupStats,
  getMoneyReceivedToday,
  getMoneyReceivedTodayByAgent,
} from '../src/db/queries/stats.js';

interface Fixture {
  groupId: string;
  agentId: string;
  customerAId: string;
  customerBId: string;
}

async function createFixture(): Promise<Fixture> {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date) VALUES ($1, $2) RETURNING id`,
    ['Stats Test Group', '2026-09-20'],
  );
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(`INSERT INTO agents (name) VALUES ($1) RETURNING id`, [
    'Stats Test Agent',
  ]);
  assert.ok(group);
  assert.ok(agent);

  const insertCustomer = (firstName: string, passport: string, gender: string, price: number) =>
    pool.query<{ id: string }>(
      `INSERT INTO customers (
         group_id, agent_id, first_name, surname, passport_number,
         date_of_birth, passport_issue_date, passport_expiry_date,
         gender, nationality, package_price
       ) VALUES ($1,$2,$3,'Tester',$4,'1990-01-01','2020-01-01','2030-01-01',$5,'UZB',$6)
       RETURNING id`,
      [group.id, agent.id, firstName, passport, gender, price],
    );

  const {
    rows: [customerA],
  } = await insertCustomer('John', 'TEST-P1', 'male', 1000);
  const {
    rows: [customerB],
  } = await insertCustomer('Jane', 'TEST-P2', 'female', 1200);
  assert.ok(customerA);
  assert.ok(customerB);

  return { groupId: group.id, agentId: agent.id, customerAId: customerA.id, customerBId: customerB.id };
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  await pool.query('DELETE FROM customers WHERE group_id = $1', [fixture.groupId]);
  await pool.query('DELETE FROM agents WHERE id = $1', [fixture.agentId]);
  await pool.query('DELETE FROM groups WHERE id = $1', [fixture.groupId]);
}

test('schema relationships and stats views compute expected values', async () => {
  const fixture = await createFixture();
  try {
    const beforeToday = Number(await getMoneyReceivedToday());
    const beforeAgentRows = await getMoneyReceivedTodayByAgent();
    const beforeAgentTotal = Number(
      beforeAgentRows.find((row) => row.agentId === fixture.agentId)?.totalReceived ?? 0,
    );

    await pool.query(
      `INSERT INTO payments (customer_id, amount, currency, payment_date) VALUES ($1, $2, 'USD', CURRENT_DATE)`,
      [fixture.customerAId, 400],
    );
    await pool.query(
      `INSERT INTO payments (customer_id, amount, currency, payment_date) VALUES ($1, $2, 'USD', CURRENT_DATE)`,
      [fixture.customerBId, 500],
    );

    const groupStats = await getGroupStats(fixture.groupId);
    assert.deepEqual(groupStats, {
      groupId: fixture.groupId,
      totalCustomers: 2,
      menCount: 1,
      womenCount: 1,
    });

    const balanceA = await getCustomerBalance(fixture.customerAId);
    assert.equal(balanceA?.totalPaid, '400.00');
    assert.equal(balanceA?.remainingBalance, '600.00');

    const balanceB = await getCustomerBalance(fixture.customerBId);
    assert.equal(balanceB?.totalPaid, '500.00');
    assert.equal(balanceB?.remainingBalance, '700.00');

    const groupMoney = await getGroupMoneyTotal(fixture.groupId);
    assert.equal(groupMoney, '900.00');

    const afterToday = Number(await getMoneyReceivedToday());
    assert.equal(afterToday - beforeToday, 900);

    const afterAgentRows = await getMoneyReceivedTodayByAgent();
    const afterAgentTotal = Number(
      afterAgentRows.find((row) => row.agentId === fixture.agentId)?.totalReceived ?? 0,
    );
    assert.equal(afterAgentTotal - beforeAgentTotal, 900);
  } finally {
    await deleteFixture(fixture);
  }
});

test('passport_expiry_date must be after passport_issue_date', async () => {
  const {
    rows: [group],
  } = await pool.query<{ id: string }>(
    `INSERT INTO groups (name, departure_date) VALUES ($1, $2) RETURNING id`,
    ['Constraint Test Group', '2026-09-20'],
  );
  const {
    rows: [agent],
  } = await pool.query<{ id: string }>(`INSERT INTO agents (name) VALUES ($1) RETURNING id`, [
    'Constraint Test Agent',
  ]);
  assert.ok(group);
  assert.ok(agent);

  try {
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO customers (
           group_id, agent_id, first_name, surname, passport_number,
           date_of_birth, passport_issue_date, passport_expiry_date,
           gender, nationality, package_price
         ) VALUES ($1,$2,'Bad','Dates','TEST-P3','1990-01-01','2030-01-01','2020-01-01','male','UZB',1000)`,
        [group.id, agent.id],
      ),
    );
  } finally {
    await pool.query('DELETE FROM agents WHERE id = $1', [agent.id]);
    await pool.query('DELETE FROM groups WHERE id = $1', [group.id]);
  }
});

after(async () => {
  await pool.end();
});
