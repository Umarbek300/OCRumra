-- Shared enum types
CREATE TYPE customer_gender AS ENUM ('male', 'female', 'unspecified');
CREATE TYPE customer_status AS ENUM ('draft', 'needs_review', 'confirmed', 'cancelled');
CREATE TYPE payment_method AS ENUM ('cash', 'bank_transfer', 'card', 'other');

-- Shared trigger function that keeps updated_at current on row updates
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
