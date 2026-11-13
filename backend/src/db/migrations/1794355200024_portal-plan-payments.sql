-- Up Migration
-- Pagos de MENSUALIDAD hechos por el cliente en el portal (Wompi o simulado). Igual que los pagos
-- por horas: se dan por buenos solo con el evento firmado de Wompi o consultando a Wompi.
-- Al aprobarse se crea el pago normal de la mensualidad (monthly_payments, consecutivo FM).

CREATE TABLE portal_plan_payments (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id            integer NOT NULL REFERENCES sites (id),
  monthly_plan_id    bigint NOT NULL REFERENCES monthly_plans (id),
  reference          text NOT NULL UNIQUE,                 -- NXM-<mensualidad>-<aleatorio>
  amount             money_cop NOT NULL CHECK (amount > 0),
  -- FIRST = primer pago pendiente · RENEW = renovación · PREPAY = pago adelantado (período en cola)
  mode               text NOT NULL CHECK (mode IN ('FIRST', 'RENEW', 'PREPAY')),
  status             text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR')),
  provider           text NOT NULL DEFAULT 'wompi' CHECK (provider IN ('wompi', 'mock')),
  provider_tx_id     text UNIQUE,
  paid_at            timestamptz,
  monthly_payment_id bigint REFERENCES monthly_payments (id),   -- pago registrado en la mensualidad
  apply_error        text,                                      -- si se cobró pero no se pudo aplicar (revisar a mano)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'APPROVED') = (paid_at IS NOT NULL))
);
CREATE INDEX portal_plan_payments_plan_idx ON portal_plan_payments (monthly_plan_id, created_at DESC);

CREATE TRIGGER portal_plan_payments_updated_at BEFORE UPDATE ON portal_plan_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS portal_plan_payments;
