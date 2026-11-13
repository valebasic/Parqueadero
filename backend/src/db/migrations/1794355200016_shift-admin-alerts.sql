-- Up Migration
-- Panel multisede, parte 2: ajuste autorizado de turnos (RF46) y alertas configurables (RF32).

-- RF46: horas trabajadas ajustadas. NULL = se usan opened_at / closed_at reales (que nunca se tocan).
ALTER TABLE shifts
  ADD COLUMN worked_start timestamptz,
  ADD COLUMN worked_end   timestamptz,
  ADD CONSTRAINT shifts_worked_range_check CHECK (
    worked_start IS NULL OR worked_end IS NULL OR worked_end > worked_start
  );

-- Historial de ajustes (quién autorizó, por qué, antes y después)
CREATE TABLE shift_adjustments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id       bigint NOT NULL REFERENCES shifts (id),
  site_id        integer NOT NULL REFERENCES sites (id),
  previous_start timestamptz NOT NULL,
  previous_end   timestamptz,
  new_start      timestamptz NOT NULL,
  new_end        timestamptz,
  reason         text NOT NULL CHECK (length(trim(reason)) >= 10),
  authorized_by  integer NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (new_end IS NULL OR new_end > new_start)
);
CREATE INDEX shift_adjustments_shift_idx ON shift_adjustments (shift_id);

-- RF32: configuración de alertas por sede (ver services/admin/alerts.service.js para los valores por defecto)
ALTER TABLE sites ADD COLUMN alert_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Alertas del panel. OPEN → ATTENDED (se atendió) o DISMISSED (se descartó), con nota y auditoría.
CREATE TABLE alerts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id       integer NOT NULL REFERENCES sites (id),
  zone_id       integer REFERENCES zones (id),
  type          text NOT NULL CHECK (type IN ('ZONE_WITHOUT_SHIFT', 'OCCUPANCY_HIGH', 'CASH_DIFFERENCE', 'SITE_OFFLINE')),
  severity      text NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('WARNING', 'DANGER')),
  message       text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text NOT NULL,              -- evita repetir la misma alerta
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ATTENDED', 'DISMISSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   integer REFERENCES users (id),
  resolution_note text,
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  CHECK (status = 'OPEN' OR resolved_by IS NOT NULL)
);
-- Nunca dos alertas abiertas con la misma clave en una sede
CREATE UNIQUE INDEX alerts_one_open_per_key ON alerts (site_id, dedupe_key) WHERE status = 'OPEN';
CREATE INDEX alerts_site_status_idx ON alerts (site_id, status, created_at DESC);
CREATE INDEX alerts_key_idx ON alerts (site_id, dedupe_key, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS alerts;
ALTER TABLE sites DROP COLUMN IF EXISTS alert_config;
DROP TABLE IF EXISTS shift_adjustments;
ALTER TABLE shifts
  DROP CONSTRAINT IF EXISTS shifts_worked_range_check,
  DROP COLUMN IF EXISTS worked_end,
  DROP COLUMN IF EXISTS worked_start;
