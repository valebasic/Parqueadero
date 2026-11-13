-- Up Migration
-- Notificaciones por correo (V4): comprobante de pago del portal y avisos de mensualidad.

-- Correo opcional que el cliente deja en el portal SOLO para recibir su comprobante
ALTER TABLE portal_payments ADD COLUMN notify_email text
  CHECK (notify_email IS NULL OR notify_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- Bitácora de envíos. dedupe_key evita repetir el mismo aviso (p. ej. "vence en 3 días" una sola vez).
-- No guarda el correo completo: solo una versión enmascarada (a***@gmail.com).
CREATE TABLE notification_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]*$'),   -- PAYMENT_RECEIPT, MONTHLY_DUE, MONTHLY_OVERDUE
  channel     text NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL', 'SMS')),
  site_id     integer REFERENCES sites (id),
  entity_type text,
  entity_id   text,
  recipient   text NOT NULL,
  dedupe_key  text NOT NULL UNIQUE,
  -- SENT = enviado · SIMULATED = modo de pruebas (solo se mostró en consola) · FAILED = falló
  status      text NOT NULL CHECK (status IN ('SENT', 'SIMULATED', 'FAILED')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_log_entity_idx ON notification_log (entity_type, entity_id);

-- Down Migration
DROP TABLE IF EXISTS notification_log;
ALTER TABLE portal_payments DROP COLUMN IF EXISTS notify_email;
