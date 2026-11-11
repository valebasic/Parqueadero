-- Up Migration
-- Bitácora de acciones sensibles (login, cambios de usuarios, tarifas, anulaciones, cierres de caja...).

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     integer REFERENCES users (id),   -- NULL = sistema o intento de login de usuario inexistente
  site_id     integer REFERENCES sites (id),
  action      text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]*$'),  -- p. ej. LOGIN_FAILED, USER_CREATED
  entity_type text,
  entity_id   text,
  ip_address  inet,
  user_agent  text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- Solo se puede insertar: nadie modifica ni borra la bitácora desde la aplicación
CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- Down Migration
DROP TABLE IF EXISTS audit_log;
DROP FUNCTION IF EXISTS audit_log_append_only();
