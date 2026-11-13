-- Up Migration
-- Códigos de un solo uso para que un cliente con mensualidad consulte sus datos en el portal
-- (V4, pantalla 3). Se envían al correo registrado en la mensualidad; nunca se guardan en claro.

CREATE TABLE portal_codes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monthly_plan_id bigint NOT NULL REFERENCES monthly_plans (id),
  code_hash       text NOT NULL,                      -- HMAC del código de 6 dígitos
  attempts        smallint NOT NULL DEFAULT 0,        -- intentos fallidos (máximo 5)
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_codes_plan_idx ON portal_codes (monthly_plan_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS portal_codes;
