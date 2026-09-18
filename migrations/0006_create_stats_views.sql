-- Total / men / women per group (cancelled customers excluded)
CREATE VIEW group_customer_stats AS
SELECT
  g.id AS group_id,
  count(c.id) FILTER (WHERE c.status <> 'cancelled') AS total_customers,
  count(c.id) FILTER (WHERE c.status <> 'cancelled' AND c.gender = 'male') AS men_count,
  count(c.id) FILTER (WHERE c.status <> 'cancelled' AND c.gender = 'female') AS women_count
FROM groups g
LEFT JOIN customers c ON c.group_id = g.id
GROUP BY g.id;

-- Per-customer amount paid and remaining balance (never stored directly)
CREATE VIEW customer_balances AS
SELECT
  c.id AS customer_id,
  c.group_id,
  c.agent_id,
  c.package_price,
  COALESCE(SUM(p.amount), 0) AS total_paid,
  c.package_price - COALESCE(SUM(p.amount), 0) AS remaining_balance
FROM customers c
LEFT JOIN payments p ON p.customer_id = c.id
GROUP BY c.id;

-- Total money received per group, to date
CREATE VIEW group_money_totals AS
SELECT
  c.group_id,
  COALESCE(SUM(p.amount), 0) AS total_received
FROM customers c
JOIN payments p ON p.customer_id = c.id
GROUP BY c.group_id;

-- Money received per calendar day, across all agents
CREATE VIEW daily_money_totals AS
SELECT
  p.payment_date,
  SUM(p.amount) AS total_received
FROM payments p
GROUP BY p.payment_date;

-- Money received per calendar day, broken down by agent
CREATE VIEW daily_agent_totals AS
SELECT
  c.agent_id,
  p.payment_date,
  SUM(p.amount) AS total_received
FROM payments p
JOIN customers c ON c.id = p.customer_id
GROUP BY c.agent_id, p.payment_date;
