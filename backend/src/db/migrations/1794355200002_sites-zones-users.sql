-- Up Migration
-- Sedes, zonas y usuarios.

-- Sede (parqueadero). Reemplaza la "Información del local" de la configuración de la v1.0.
CREATE TABLE sites (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                   text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name                   text NOT NULL CHECK (length(trim(name)) > 0),
  legal_id               text,                 -- NIT
  phone                  text,
  address                text,
  city                   text,
  capacity               integer CHECK (capacity >= 0),
  receipt_prefix         text NOT NULL DEFAULT 'FA' CHECK (receipt_prefix ~ '^[A-Z]{1,5}$'),
  monthly_receipt_prefix text NOT NULL DEFAULT 'FM' CHECK (monthly_receipt_prefix ~ '^[A-Z]{1,5}$'),
  timezone               text NOT NULL DEFAULT 'America/Bogota',
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sites_set_updated_at BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Zona dentro de una sede (sector, piso, cubierta/descubierta...)
CREATE TABLE zones (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id     integer NOT NULL REFERENCES sites (id),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  capacity    integer CHECK (capacity >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name),
  -- Permite que otras tablas exijan que la zona pertenezca a la misma sede (FK compuesta)
  UNIQUE (id, site_id)
);
CREATE TRIGGER zones_set_updated_at BEFORE UPDATE ON zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Usuarios. Roles: AG = administrador general, AS = administrador de sede, OP = operador.
-- No se borran: se desactivan (is_active = false) para conservar la trazabilidad.
CREATE TABLE users (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username            text NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{3,40}$'),
  full_name           text NOT NULL CHECK (length(trim(full_name)) > 0),
  password_hash       text NOT NULL,           -- bcrypt
  role                text NOT NULL CHECK (role IN ('AG', 'AS', 'OP')),
  is_active           boolean NOT NULL DEFAULT true,
  failed_login_count  integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        timestamptz,
  last_login_at       timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by          integer REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Usuario único sin distinguir mayúsculas ("Felipe" = "felipe")
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sedes asignadas a cada AS y OP. El AG tiene acceso a todas y no necesita filas aquí.
CREATE TABLE user_sites (
  user_id    integer NOT NULL REFERENCES users (id),
  site_id    integer NOT NULL REFERENCES sites (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site_id)
);
CREATE INDEX user_sites_site_id_idx ON user_sites (site_id);

-- Down Migration
DROP TABLE IF EXISTS user_sites;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS zones;
DROP TABLE IF EXISTS sites;
