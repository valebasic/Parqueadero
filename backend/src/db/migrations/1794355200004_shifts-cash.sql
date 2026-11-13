-- Up Migration
-- Turnos, cajas y movimientos de caja.

-- Turno de un usuario en una zona de una sede. Cada turno tiene exactamente una caja (cash_registers).
-- Entregar el turno = cerrar este turno (y su caja) y abrir otro en la misma zona.
CREATE TABLE shifts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id    integer NOT NULL REFERENCES sites (id),
  zone_id    integer NOT NULL,
  user_id    integer NOT NULL REFERENCES users (id),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz,
  notes      text,
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  FOREIGN KEY (zone_id, site_id) REFERENCES zones (id, site_id),
  UNIQUE (id, site_id)
);
-- Un usuario no puede tener dos turnos abiertos
CREATE UNIQUE INDEX shifts_one_open_per_user ON shifts (user_id) WHERE closed_at IS NULL;
-- Una zona no puede tener dos turnos abiertos (RF41/RF42: apertura y entrega de turno por zona)
CREATE UNIQUE INDEX shifts_one_open_per_zone ON shifts (zone_id) WHERE closed_at IS NULL;
CREATE INDEX shifts_site_opened_idx ON shifts (site_id, opened_at DESC);

-- Caja de un turno (una por turno). Efectivo esperado = efectivo de ventas + ingresos - egresos;
-- la base no se suma al esperado (regla vigente de la v1.0).
CREATE TABLE cash_registers (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id       integer NOT NULL,
  shift_id      bigint NOT NULL UNIQUE,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opened_by     integer NOT NULL REFERENCES users (id),
  initial_cash  money_cop NOT NULL DEFAULT 0,   -- base inicial
  closed_at     timestamptz,
  closed_by     integer REFERENCES users (id),
  physical_cash money_cop,                      -- efectivo contado al cerrar
  expected_cash integer,                        -- puede ser negativo si los egresos superan lo recibido
  difference    integer,                        -- físico - esperado
  summary       jsonb,                          -- resumen congelado del cierre (no se recalcula)
  notes         text,
  FOREIGN KEY (shift_id, site_id) REFERENCES shifts (id, site_id),
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  -- Una caja cerrada siempre tiene quién la cerró y el efectivo contado
  CHECK (
    (closed_at IS NULL AND closed_by IS NULL AND physical_cash IS NULL)
    OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND physical_cash IS NOT NULL)
  )
);
CREATE INDEX cash_registers_site_opened_idx ON cash_registers (site_id, opened_at DESC);
CREATE INDEX cash_registers_open_idx ON cash_registers (site_id) WHERE closed_at IS NULL;

-- "Cada turno con exactamente una caja": como máximo una lo garantiza UNIQUE (shift_id); que exista
-- al menos una se revisa al confirmar la transacción (trigger diferido), así el turno y su caja se
-- crean juntos en la misma transacción. También se exige que un turno cerrado tenga su caja cerrada.
CREATE FUNCTION shifts_check_cash_register() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  register_closed_at timestamptz;
BEGIN
  SELECT closed_at INTO register_closed_at FROM cash_registers WHERE shift_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El turno % no tiene caja: cada turno debe abrirse con su caja', NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.closed_at IS NOT NULL AND register_closed_at IS NULL THEN
    RAISE EXCEPTION 'El turno % no se puede cerrar con la caja abierta', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER shifts_require_cash_register
  AFTER INSERT OR UPDATE ON shifts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shifts_check_cash_register();

-- La caja de un turno no se puede borrar ni pasar a otro turno
CREATE FUNCTION cash_registers_protect_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Las cajas no se borran' USING ERRCODE = '23514';
  END IF;
  IF NEW.shift_id <> OLD.shift_id THEN
    RAISE EXCEPTION 'La caja no se puede pasar a otro turno' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_registers_protect_shift
  BEFORE UPDATE OR DELETE ON cash_registers
  FOR EACH ROW EXECUTE FUNCTION cash_registers_protect_shift();

-- Movimientos manuales de caja (v1.0: Transacciones).
--   INCOME   = ingreso manual (suma al efectivo esperado)
--   EXPENSE  = egreso (resta del efectivo esperado)
--   BASE_IN  = "Base +"  (solo modifica la base del día)
--   BASE_OUT = "Base -"  (solo modifica la base del día)
CREATE TABLE cash_movements (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cash_register_id bigint NOT NULL REFERENCES cash_registers (id),
  type             text NOT NULL CHECK (type IN ('INCOME', 'EXPENSE', 'BASE_IN', 'BASE_OUT')),
  amount           money_cop NOT NULL CHECK (amount > 0),
  concept          text,
  created_by       integer NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       integer REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Borrado lógico: se conserva el registro para auditoría
  deleted_by       integer REFERENCES users (id),
  deleted_at       timestamptz,
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE INDEX cash_movements_register_idx ON cash_movements (cash_register_id) WHERE deleted_at IS NULL;
CREATE TRIGGER cash_movements_set_updated_at BEFORE UPDATE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS cash_movements;
DROP TABLE IF EXISTS cash_registers;
DROP TABLE IF EXISTS shifts;
DROP FUNCTION IF EXISTS cash_registers_protect_shift();
DROP FUNCTION IF EXISTS shifts_check_cash_register();
