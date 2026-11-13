-- Up Migration
-- Pagos del portal del cliente (V4, RF53-RF59): el cliente paga desde el celular con Wompi antes de
-- salir. El pago se da por bueno SOLO cuando llega el evento firmado de Wompi (o la verificación
-- directa con Wompi); volver a la página no basta.

CREATE TABLE portal_payments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id        integer NOT NULL REFERENCES sites (id),
  entry_id       bigint NOT NULL REFERENCES entries (id),
  -- Referencia única enviada a Wompi (impredecible: se usa también para consultar el estado)
  reference      text NOT NULL UNIQUE,
  amount         money_cop NOT NULL CHECK (amount > 0),
  -- PENDING = esperando a Wompi · APPROVED = pagado · DECLINED/VOIDED/ERROR = no se cobró
  status         text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR')),
  -- 'wompi' = pasarela real (sandbox o producción) · 'mock' = simulado para pruebas sin cuenta
  provider       text NOT NULL DEFAULT 'wompi' CHECK (provider IN ('wompi', 'mock')),
  provider_tx_id text UNIQUE,                      -- id de la transacción en Wompi (idempotencia)
  paid_at        timestamptz,                      -- cuándo se aprobó (empieza la ventana de salida)
  consumed_at    timestamptz,                      -- cuándo el operador la aplicó al dar salida
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'APPROVED') = (paid_at IS NOT NULL))
);

CREATE INDEX portal_payments_entry_idx ON portal_payments (entry_id);
-- Un solo pago aprobado sin aplicar por entrada
CREATE UNIQUE INDEX portal_payments_one_credit_per_entry
  ON portal_payments (entry_id) WHERE status = 'APPROVED' AND consumed_at IS NULL;

CREATE TRIGGER portal_payments_updated_at BEFORE UPDATE ON portal_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS portal_payments;
