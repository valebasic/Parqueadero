-- Up Migration
-- Entradas/salidas de vehículos (cada salida cobrada es una "venta de parqueadero") y cargos pendientes.

CREATE TABLE entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id           integer NOT NULL REFERENCES sites (id),
  zone_id           integer,
  plate             plate_number NOT NULL,
  vehicle_type      vehicle_type NOT NULL,
  receipt_prefix    text NOT NULL,
  receipt_number    integer NOT NULL CHECK (receipt_number > 0),
  -- OPEN = vehículo adentro; PAID = salió y se cobró; PENDING_CHARGE = salió y el cobro quedó en
  -- Pendientes; CANCELLED = entrada anulada
  status            text NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'PAID', 'PENDING_CHARGE', 'CANCELLED')),
  entry_at          timestamptz NOT NULL DEFAULT now(),
  entry_by          integer NOT NULL REFERENCES users (id),
  entry_shift_id    bigint REFERENCES shifts (id),
  exit_at           timestamptz,
  exit_by           integer REFERENCES users (id),
  exit_shift_id     bigint REFERENCES shifts (id),
  cash_register_id  bigint REFERENCES cash_registers (id),  -- caja donde se registró el cobro
  rate_id           integer REFERENCES rates (id),          -- tarifa con la que se calculó
  monthly_plan_id   bigint REFERENCES monthly_plans (id),   -- mensualidad vinculada (nocturna fuera de franja)
  billed_minutes    integer CHECK (billed_minutes >= 0),
  calculated_amount money_cop,                              -- tarifa calculada
  discount_amount   money_cop NOT NULL DEFAULT 0,
  charged_amount    money_cop,                              -- valor realmente cobrado
  payment_method    payment_method,
  cash_amount       money_cop NOT NULL DEFAULT 0,
  electronic_amount money_cop NOT NULL DEFAULT 0,
  is_manual         boolean NOT NULL DEFAULT false,         -- registrada a mano desde Reportes
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (zone_id, site_id) REFERENCES zones (id, site_id),
  UNIQUE (site_id, receipt_prefix, receipt_number),
  -- Solo las entradas abiertas no tienen hora de salida
  CHECK ((status = 'OPEN') = (exit_at IS NULL)),
  CHECK (exit_at IS NULL OR exit_at >= entry_at),
  -- Una venta cobrada siempre tiene forma de pago y los montos cuadran
  CHECK (
    status <> 'PAID' OR (
      payment_method IS NOT NULL
      AND charged_amount IS NOT NULL
      AND cash_amount + electronic_amount = charged_amount
    )
  ),
  CHECK (
    payment_method IS NULL
    OR (payment_method = 'CASH' AND electronic_amount = 0)
    OR (payment_method = 'ELECTRONIC' AND cash_amount = 0)
    OR payment_method = 'MIXED'
  )
);

-- Regla de negocio: una placa no puede tener dos entradas abiertas.
-- Carros y motos: en ninguna sede (un vehículo no puede estar en dos parqueaderos a la vez).
CREATE UNIQUE INDEX entries_one_open_per_plate
  ON entries (plate)
  WHERE status = 'OPEN' AND vehicle_type <> 'BICYCLE';
-- Ciclas: usan placas genéricas (CICLA, CICLA0, BICI1...), así que la regla es por sede.
CREATE UNIQUE INDEX entries_one_open_bicycle_per_site
  ON entries (site_id, plate)
  WHERE status = 'OPEN' AND vehicle_type = 'BICYCLE';

CREATE INDEX entries_site_entry_at_idx ON entries (site_id, entry_at DESC);
CREATE INDEX entries_site_exit_at_idx ON entries (site_id, exit_at DESC) WHERE exit_at IS NOT NULL;
CREATE INDEX entries_plate_idx ON entries (plate, entry_at DESC);
CREATE INDEX entries_cash_register_idx ON entries (cash_register_id) WHERE cash_register_id IS NOT NULL;
CREATE TRIGGER entries_set_updated_at BEFORE UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cargos pendientes (v1.0: Pendientes). Se generan, por ejemplo, cuando una mensualidad nocturna
-- sale fuera de su franja, o cuando una venta se pasa a "Pendiente". Al confirmarlos se cobran
-- en la caja abierta en ese momento y cuentan en el día de la confirmación.
CREATE TABLE pending_charges (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id          integer NOT NULL REFERENCES sites (id),
  entry_id         bigint NOT NULL UNIQUE REFERENCES entries (id),
  monthly_plan_id  bigint REFERENCES monthly_plans (id),
  plate            plate_number NOT NULL,
  amount           money_cop NOT NULL,           -- valor a cobrar
  reason           text NOT NULL CHECK (reason IN ('OUT_OF_SCHEDULE', 'MANUAL')),
  created_by       integer REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  confirmed_by     integer REFERENCES users (id),
  cash_register_id bigint REFERENCES cash_registers (id),
  CHECK (
    (confirmed_at IS NULL AND confirmed_by IS NULL AND cash_register_id IS NULL)
    OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND cash_register_id IS NOT NULL)
  )
);
CREATE INDEX pending_charges_open_idx ON pending_charges (site_id, plate) WHERE confirmed_at IS NULL;
CREATE INDEX pending_charges_plan_idx ON pending_charges (monthly_plan_id);

-- Down Migration
DROP TABLE IF EXISTS pending_charges;
DROP TABLE IF EXISTS entries;
