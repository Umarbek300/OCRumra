CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  first_name TEXT NOT NULL,
  surname TEXT NOT NULL,
  passport_number TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  passport_issue_date DATE NOT NULL,
  passport_expiry_date DATE NOT NULL,
  gender customer_gender NOT NULL,
  nationality TEXT NOT NULL,
  package_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (package_price >= 0),
  status customer_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (passport_expiry_date > passport_issue_date)
);

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_customers_group_id ON customers (group_id);
CREATE INDEX idx_customers_agent_id ON customers (agent_id);
CREATE INDEX idx_customers_passport_number ON customers (passport_number);
CREATE INDEX idx_customers_status ON customers (status);
