-- Up Migration
-- NexoIA: acciones que la IA PROPONE. Nunca se ejecutan solas: el frontend muestra una tarjeta y, si
-- la persona confirma, llama al endpoint normal de la API (mismas validaciones y permisos) y reporta
-- el resultado aquí. Todo queda además en audit_log.
CREATE TABLE ai_proposals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     integer NOT NULL REFERENCES users (id),
  site_id     integer REFERENCES sites (id),
  kind        text NOT NULL,                 -- MOVEMENT, REPORT, RATE, MONTHLY_RENEWAL, ENTRY
  title       text NOT NULL,
  request     jsonb NOT NULL,                -- { method, path, body } que ejecutará el frontend
  details     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'CONFIRMED', 'CANCELLED', 'FAILED', 'EXPIRED')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  resolved_at timestamptz,
  CHECK ((status = 'PROPOSED') = (resolved_at IS NULL))
);
CREATE INDEX ai_proposals_user_idx ON ai_proposals (user_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS ai_proposals;
