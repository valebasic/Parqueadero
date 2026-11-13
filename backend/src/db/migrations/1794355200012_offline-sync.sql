-- Up Migration
-- Operación sin conexión (RF60, RF62): operaciones encoladas en el dispositivo y sincronizadas
-- después. El id es el UUID que genera el dispositivo: repetirlo no duplica nada (idempotencia).

CREATE TABLE offline_operations (
  id                  uuid PRIMARY KEY,
  site_id             integer NOT NULL REFERENCES sites (id),
  user_id             integer NOT NULL REFERENCES users (id),
  device_id           text NOT NULL CHECK (device_id ~ '^[A-Z0-9]{4,12}$'),
  seq                 integer NOT NULL CHECK (seq > 0),            -- orden en el dispositivo
  kind                text NOT NULL CHECK (kind IN ('ENTRY', 'EXIT')),
  client_ts           timestamptz NOT NULL,                        -- hora del dispositivo
  provisional_receipt text,                                        -- FA-P-<dispositivo>-0001
  payload             jsonb NOT NULL,
  -- APPLIED = aplicada · CONFLICT = espera resolución manual (AS/AG)
  -- RESOLVED_APPLIED / RESOLVED_DISCARDED = conflicto resuelto (auditado)
  status              text NOT NULL CHECK (status IN ('APPLIED', 'CONFLICT', 'RESOLVED_APPLIED', 'RESOLVED_DISCARDED')),
  entry_id            bigint REFERENCES entries (id),
  conflict_code       text,
  conflict_detail     jsonb,
  received_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolved_by         integer REFERENCES users (id),
  resolution_note     text,
  CHECK ((status = 'CONFLICT') = (conflict_code IS NOT NULL AND resolved_at IS NULL) OR status <> 'CONFLICT'),
  CHECK (status NOT LIKE 'RESOLVED_%' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX offline_operations_conflicts_idx ON offline_operations (site_id, received_at) WHERE status = 'CONFLICT';
CREATE INDEX offline_operations_device_idx ON offline_operations (device_id, seq);

-- Entradas creadas sin conexión: el recibo provisional queda como referencia del definitivo
ALTER TABLE entries
  ADD COLUMN origin text NOT NULL DEFAULT 'ONLINE' CHECK (origin IN ('ONLINE', 'OFFLINE')),
  ADD COLUMN provisional_receipt text UNIQUE;

-- Down Migration
ALTER TABLE entries DROP COLUMN IF EXISTS provisional_receipt, DROP COLUMN IF EXISTS origin;
DROP TABLE IF EXISTS offline_operations;
