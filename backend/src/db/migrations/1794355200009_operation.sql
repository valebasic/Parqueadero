-- Up Migration
-- Operación (RF07-RF12, RF19, RF41-RF43): arqueos por denominación, relevo de turnos y
-- datos de descuento/cambio de pago en las ventas.

-- Arqueo de caja por denominación (billetes y monedas COP).
--   OPENING  = base contada al abrir el turno
--   HANDOVER = conteo al entregar el turno (lo confirman quien entrega y quien recibe)
--   CLOSING  = conteo al cerrar el turno sin relevo
CREATE TABLE cash_counts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cash_register_id bigint NOT NULL REFERENCES cash_registers (id),
  kind             text NOT NULL CHECK (kind IN ('OPENING', 'HANDOVER', 'CLOSING')),
  denominations    jsonb NOT NULL,                -- {"50000": 2, "1000": 7, ...}
  total            money_cop NOT NULL,
  expected_total   integer,                       -- lo que debía haber en el cajón (NULL en la apertura)
  difference       integer,                       -- total - expected_total
  counted_by       integer NOT NULL REFERENCES users (id),
  received_by      integer REFERENCES users (id), -- quien recibe (solo en HANDOVER)
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'HANDOVER') = (received_by IS NOT NULL)),
  CHECK (kind = 'OPENING' OR expected_total IS NOT NULL)
);
CREATE INDEX cash_counts_register_idx ON cash_counts (cash_register_id);

-- Relevo: el turno que recibe guarda de cuál viene
ALTER TABLE shifts ADD COLUMN previous_shift_id bigint REFERENCES shifts (id);
ALTER TABLE shifts ADD COLUMN close_type text CHECK (close_type IN ('HANDOVER', 'CLOSE'));
ALTER TABLE shifts ADD CONSTRAINT shifts_close_type_closed_check CHECK ((closed_at IS NULL) = (close_type IS NULL));

-- Descuento con motivo obligatorio (RF10)
ALTER TABLE entries ADD COLUMN discount_reason text;
ALTER TABLE entries ADD CONSTRAINT entries_discount_reason_check
  CHECK (discount_amount = 0 OR length(trim(coalesce(discount_reason, ''))) >= 3);

-- Cobro de un cargo pendiente: momento de confirmación (cuenta en Reportes ese día, como en la v1.0)
ALTER TABLE entries ADD COLUMN paid_at timestamptz;
ALTER TABLE entries ADD CONSTRAINT entries_paid_at_check CHECK ((status = 'PAID') = (paid_at IS NOT NULL));

-- Down Migration
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_paid_at_check;
ALTER TABLE entries DROP COLUMN IF EXISTS paid_at;
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_discount_reason_check;
ALTER TABLE entries DROP COLUMN IF EXISTS discount_reason;
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_close_type_closed_check;
ALTER TABLE shifts DROP COLUMN IF EXISTS close_type;
ALTER TABLE shifts DROP COLUMN IF EXISTS previous_shift_id;
DROP TABLE IF EXISTS cash_counts;
