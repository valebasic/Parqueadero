-- Up Migration
-- Panel del administrador multisede (RF26-RF30).

-- RF26: sede con municipio (city), horario (business_hours), capacidad por tipo de vehículo y
-- responsable (un AS asignado a la sede). La capacidad total (capacity) es la suma de las tres.
ALTER TABLE sites
  ADD COLUMN capacity_car        integer CHECK (capacity_car >= 0),
  ADD COLUMN capacity_motorcycle integer CHECK (capacity_motorcycle >= 0),
  ADD COLUMN capacity_bicycle    integer CHECK (capacity_bicycle >= 0),
  ADD COLUMN manager_user_id     integer REFERENCES users (id);

-- RF27: tipos de vehículo que admite cada zona (por defecto todos)
ALTER TABLE zones
  ADD COLUMN vehicle_types vehicle_type[] NOT NULL DEFAULT '{CAR,MOTORCYCLE,BICYCLE}'
    CHECK (cardinality(vehicle_types) > 0);

-- RF29: categoría de los egresos (estado de resultados por categoría)
ALTER TABLE cash_movements
  ADD COLUMN category text CHECK (
    category IS NULL OR category IN ('SUPPLIES', 'UTILITIES', 'PAYROLL', 'MAINTENANCE', 'RENT', 'TAXES', 'OTHER')
  );
ALTER TABLE cash_movements
  ADD CONSTRAINT cash_movements_category_expense_check CHECK (category IS NULL OR type = 'EXPENSE');

-- RF30: horario programado de cada persona por día de la semana (1 = lunes ... 7 = domingo, ISO).
-- end_time <= start_time = el turno termina al día siguiente (p. ej. 19:00 → 07:00).
-- No se borran: se desactivan.
CREATE TABLE staff_schedules (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users (id),
  site_id     integer NOT NULL REFERENCES sites (id),
  zone_id     integer NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  notes       text,
  created_by  integer REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time <> end_time),
  FOREIGN KEY (zone_id, site_id) REFERENCES zones (id, site_id)
);
CREATE INDEX staff_schedules_site_idx ON staff_schedules (site_id, weekday) WHERE is_active;
CREATE INDEX staff_schedules_user_idx ON staff_schedules (user_id, weekday) WHERE is_active;
CREATE TRIGGER staff_schedules_set_updated_at BEFORE UPDATE ON staff_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS staff_schedules;
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_category_expense_check;
ALTER TABLE cash_movements DROP COLUMN IF EXISTS category;
ALTER TABLE zones DROP COLUMN IF EXISTS vehicle_types;
ALTER TABLE sites
  DROP COLUMN IF EXISTS manager_user_id,
  DROP COLUMN IF EXISTS capacity_bicycle,
  DROP COLUMN IF EXISTS capacity_motorcycle,
  DROP COLUMN IF EXISTS capacity_car;
