-- Up Migration
-- Sesiones de usuario (RF01-RF06).
-- El navegador guarda el refresh token en una cookie httpOnly; aquí solo se guarda su hash SHA-256.
-- Cada petición autenticada revisa la sesión: si fue revocada, venció o lleva demasiado tiempo
-- inactiva (15 min OP, 30 min AS/AG), se rechaza aunque el JWT siga vigente.

CREATE TABLE user_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            integer NOT NULL REFERENCES users (id),
  refresh_token_hash text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,    -- duración máxima de la sesión, aunque haya actividad
  revoked_at         timestamptz,
  revoked_reason     text CHECK (revoked_reason IN
                       ('LOGOUT', 'IDLE', 'EXPIRED', 'USER_DEACTIVATED', 'PASSWORD_CHANGED', 'PASSWORD_RESET')),
  ip_address         inet,
  user_agent         text,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX user_sessions_active_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS user_sessions;
