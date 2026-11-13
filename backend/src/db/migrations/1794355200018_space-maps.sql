-- Up Migration
-- Mapa de espacios (RF47-RF52).
--
--   zone_maps       versiones del plano de cada zona (cuadrícula filas × columnas + elementos en
--                   JSON). Se edita como BORRADOR y se PUBLICA; la publicada anterior queda ARCHIVADA.
--   parking_spaces  los puestos "vivos" de cada zona, identificados por su código (sobreviven a las
--                   versiones del plano): tipo, uso, techado, posición, distancia a la entrada,
--                   bloqueo con motivo y reserva para un titular de mensualidad.
--   entries.space_id  puesto ocupado por la entrada. Un puesto no puede tener dos entradas abiertas
--                   (índice único parcial: garantiza la concurrencia aunque dos operadores elijan el
--                   mismo puesto a la vez).

CREATE TABLE zone_maps (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id      integer NOT NULL REFERENCES sites (id),
  zone_id      integer NOT NULL,
  version      integer NOT NULL CHECK (version > 0),
  status       text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  rows         smallint NOT NULL CHECK (rows BETWEEN 1 AND 80),
  cols         smallint NOT NULL CHECK (cols BETWEEN 1 AND 80),
  elements     jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes        text,
  created_by   integer REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   integer REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_by integer REFERENCES users (id),
  published_at timestamptz,
  FOREIGN KEY (zone_id, site_id) REFERENCES zones (id, site_id),
  UNIQUE (zone_id, version),
  CHECK ((status = 'DRAFT') = (published_at IS NULL))
);
-- Un solo borrador y una sola versión publicada por zona
CREATE UNIQUE INDEX zone_maps_one_draft ON zone_maps (zone_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX zone_maps_one_published ON zone_maps (zone_id) WHERE status = 'PUBLISHED';

CREATE TABLE parking_spaces (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id           integer NOT NULL REFERENCES sites (id),
  zone_id           integer NOT NULL,
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9-]{1,10}$'),
  space_type        text NOT NULL CHECK (space_type IN ('CAR', 'MOTORCYCLE', 'BICYCLE', 'REDUCED_MOBILITY')),
  usage             text NOT NULL CHECK (usage IN ('MONTHLY', 'HOURLY', 'MIXED')),
  covered           boolean NOT NULL DEFAULT false,
  row               smallint NOT NULL,
  col               smallint NOT NULL,
  width             smallint NOT NULL CHECK (width IN (1, 2)),
  height            smallint NOT NULL CHECK (height IN (1, 2)),
  entrance_distance integer,               -- celdas hasta la entrada más cercana (para sugerir)
  is_active         boolean NOT NULL DEFAULT true,  -- false = ya no está en el plano publicado
  map_version       integer NOT NULL,
  blocked_at        timestamptz,
  blocked_by        integer REFERENCES users (id),
  blocked_reason    text,
  reserved_plan_id  bigint REFERENCES monthly_plans (id),   -- reservado para el titular de esta mensualidad
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (zone_id, site_id) REFERENCES zones (id, site_id),
  UNIQUE (zone_id, code),
  CHECK ((blocked_at IS NULL) = (blocked_reason IS NULL)),
  CHECK (width * height <= 2)
);
CREATE INDEX parking_spaces_zone_idx ON parking_spaces (zone_id) WHERE is_active;
-- Un titular de mensualidad tiene a lo sumo un puesto reservado
CREATE UNIQUE INDEX parking_spaces_one_reservation ON parking_spaces (reserved_plan_id) WHERE reserved_plan_id IS NOT NULL;
CREATE TRIGGER parking_spaces_set_updated_at BEFORE UPDATE ON parking_spaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE entries ADD COLUMN space_id bigint REFERENCES parking_spaces (id);
CREATE UNIQUE INDEX entries_one_open_per_space ON entries (space_id) WHERE status = 'OPEN' AND space_id IS NOT NULL;
CREATE INDEX entries_space_idx ON entries (space_id, entry_at) WHERE space_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS entries_space_idx;
DROP INDEX IF EXISTS entries_one_open_per_space;
ALTER TABLE entries DROP COLUMN IF EXISTS space_id;
DROP TABLE IF EXISTS parking_spaces;
DROP TABLE IF EXISTS zone_maps;
