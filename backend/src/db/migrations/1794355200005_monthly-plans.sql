-- Up Migration
-- Mensualidades y sus pagos. Los pagos de mensualidad NO pasan por caja (regla vigente de la v1.0).

CREATE TABLE monthly_plans (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id              integer NOT NULL REFERENCES sites (id),
  plate                plate_number NOT NULL,
  vehicle_type         vehicle_type NOT NULL,
  client_name          text NOT NULL CHECK (length(trim(client_name)) > 0),
  phones               text[] NOT NULL DEFAULT '{}',
  start_date           date NOT NULL,
  end_date             date NOT NULL,
  amount               money_cop NOT NULL,       -- valor mensual pactado
  -- Horario: DAY bloquea cualquier entrada normal; NIGHT solo dentro de la franja [night_start, night_end)
  schedule             text NOT NULL DEFAULT 'DAY' CHECK (schedule IN ('DAY', 'NIGHT')),
  night_start          time,
  night_end            time,
  is_active            boolean NOT NULL DEFAULT true,
  -- PENDING = registrada sin pagar; PARTIAL = quincenal con 1.er abono; PAID = al día;
  -- PENDING_CONFIRMATION = importada por CSV, falta que un administrador confirme el pago
  payment_status       text NOT NULL DEFAULT 'PENDING'
                         CHECK (payment_status IN ('PENDING', 'PARTIAL', 'PAID', 'PENDING_CONFIRMATION')),
  is_biweekly          boolean NOT NULL DEFAULT false,
  installment_due_date date,                     -- plazo del 2.º abono quincenal
  origin               text NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL', 'CSV_IMPORT', 'V1_MIGRATION')),
  created_by           integer REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (schedule = 'DAY' OR (night_start IS NOT NULL AND night_end IS NOT NULL)),
  CHECK (payment_status <> 'PARTIAL' OR is_biweekly)
);
CREATE INDEX monthly_plans_plate_idx ON monthly_plans (plate, end_date DESC);
CREATE INDEX monthly_plans_site_end_idx ON monthly_plans (site_id, end_date);
CREATE TRIGGER monthly_plans_set_updated_at BEFORE UPDATE ON monthly_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE monthly_payments (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id            integer NOT NULL REFERENCES sites (id),
  monthly_plan_id    bigint NOT NULL REFERENCES monthly_plans (id),
  receipt_prefix     text NOT NULL,
  receipt_number     integer NOT NULL CHECK (receipt_number > 0),
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  base_amount        money_cop NOT NULL,          -- valor sugerido antes de descuento
  discount_amount    money_cop NOT NULL DEFAULT 0,
  amount             money_cop NOT NULL,          -- valor realmente cobrado
  payment_method     payment_method NOT NULL,
  cash_amount        money_cop NOT NULL DEFAULT 0,
  electronic_amount  money_cop NOT NULL DEFAULT 0,
  installment_number smallint CHECK (installment_number IN (1, 2)),  -- abono quincenal (NULL = pago único)
  is_advance         boolean NOT NULL DEFAULT false,                 -- pago por adelantado del siguiente período
  paid_at            timestamptz NOT NULL DEFAULT now(),
  paid_by            integer REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, receipt_prefix, receipt_number),
  CHECK (period_end >= period_start),
  CHECK (cash_amount + electronic_amount = amount),
  CHECK (
    (payment_method = 'CASH' AND electronic_amount = 0)
    OR (payment_method = 'ELECTRONIC' AND cash_amount = 0)
    OR payment_method = 'MIXED'
  )
);
CREATE INDEX monthly_payments_plan_idx ON monthly_payments (monthly_plan_id, period_start);
CREATE INDEX monthly_payments_paid_at_idx ON monthly_payments (site_id, paid_at);

-- Down Migration
DROP TABLE IF EXISTS monthly_payments;
DROP TABLE IF EXISTS monthly_plans;
