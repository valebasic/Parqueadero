-- Up Migration
-- Migración de datos de la v1.0 (localStorage de Electron).

-- Contraseñas de la v1.0 ("<salt_hex_32>:<sha256_hex_64>", SHA-256 de salt + ':' + contraseña).
-- Se guardan tal cual en legacy_password_hash; en el primer inicio de sesión correcto se verifican con
-- ese formato, se re-hashean con bcrypt y se borra el legacy. Un usuario tiene uno de los dos.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN legacy_password_hash text CHECK (legacy_password_hash ~ '^[0-9a-f]{32}:[0-9a-f]{64}$'),
  ADD CONSTRAINT users_password_present_check CHECK (password_hash IS NOT NULL OR legacy_password_hash IS NOT NULL);

-- Entradas/ventas traídas de la v1.0
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_origin_check;
ALTER TABLE entries ADD CONSTRAINT entries_origin_check CHECK (origin IN ('ONLINE', 'OFFLINE', 'V1_IMPORT'));

-- Registro v1 → v2 de lo importado: correr la migración otra vez no duplica nada.
CREATE TABLE v1_import_map (
  site_id     integer NOT NULL REFERENCES sites (id),
  entity      text NOT NULL,     -- user, entry, monthly_plan, monthly_payment, movement, closure, ...
  v1_key      text NOT NULL,     -- id del registro en la v1.0
  v2_id       bigint,            -- id creado en la v2.0 (NULL si el registro se omitió a propósito)
  imported_at timestamptz NOT NULL DEFAULT now(),
  run_id      bigint,
  PRIMARY KEY (site_id, entity, v1_key)
);

-- Cada ejecución real (no las de prueba --dry-run) con su reporte
CREATE TABLE v1_import_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id     integer NOT NULL REFERENCES sites (id),
  file_name   text,
  file_sha256 text NOT NULL,
  exported_at timestamptz,
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS v1_import_runs;
DROP TABLE IF EXISTS v1_import_map;
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_origin_check;
ALTER TABLE entries ADD CONSTRAINT entries_origin_check CHECK (origin IN ('ONLINE', 'OFFLINE'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_present_check;
ALTER TABLE users DROP COLUMN IF EXISTS legacy_password_hash;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
