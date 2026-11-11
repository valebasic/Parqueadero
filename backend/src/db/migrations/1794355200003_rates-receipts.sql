-- Up Migration
-- Tarifas por sede y tipo de vehículo, con vigencia, y consecutivos de recibos.

-- Tarifa vigente en [valid_from, valid_to). valid_to NULL = vigente sin fecha de fin.
-- Cambiar una tarifa = cerrar la vigencia de la actual e insertar una nueva (el historial se conserva,
-- así cada entrada guarda con qué tarifa se cobró).
CREATE TABLE rates (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id         integer NOT NULL REFERENCES sites (id),
  vehicle_type    vehicle_type NOT NULL,
  fraction_amount money_cop NOT NULL DEFAULT 0,  -- 1 a 45 minutos
  hour_amount     money_cop NOT NULL DEFAULT 0,  -- cada hora (46 a 60 minutos cuenta como hora)
  full_12h_amount money_cop NOT NULL DEFAULT 0,  -- tarifa plena por bloque de 12 h
  monthly_amount  money_cop NOT NULL DEFAULT 0,  -- mensualidad
  -- Modo de cobro:
  --   normal   = fracción / hora por bloques de 12 h, topado en la tarifa plena (calculateTariff de la v1.0)
  --   block12h = tarifa plena por cada bloque de 12 h o fracción iniciado (ciclas)
  pricing_mode    text NOT NULL DEFAULT 'normal' CHECK (pricing_mode IN ('normal', 'block12h')),
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  created_by      integer REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- El cobro por bloques necesita una tarifa plena mayor que cero
  CHECK (pricing_mode <> 'block12h' OR full_12h_amount > 0),
  -- Nunca dos tarifas vigentes a la vez para la misma sede y tipo de vehículo
  CONSTRAINT rates_no_overlap EXCLUDE USING gist (
    site_id WITH =,
    vehicle_type WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  )
);

-- Consecutivo de recibos por sede y prefijo (FA = entradas/salidas, FM = mensualidades).
-- Se toma el siguiente número con UPDATE ... SET last_number = last_number + 1 RETURNING last_number,
-- que bloquea la fila y evita números repetidos aunque haya varios operadores a la vez.
CREATE TABLE receipt_counters (
  site_id     integer NOT NULL REFERENCES sites (id),
  prefix      text NOT NULL CHECK (prefix ~ '^[A-Z]{1,5}$'),
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (site_id, prefix)
);

-- Down Migration
DROP TABLE IF EXISTS receipt_counters;
DROP TABLE IF EXISTS rates;
