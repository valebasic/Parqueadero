-- Up Migration
-- Reloj del dispositivo en la sincronización: el dispositivo envía su hora al momento de enviar el
-- lote y el servidor guarda la hora en que lo recibió. Si difieren más de 10 minutos, o la hora de
-- la operación queda en el futuro respecto a la recepción, la operación se marca (sin bloquear el
-- cobro), se audita y se muestra como advertencia en la bandeja de conflictos.
ALTER TABLE offline_operations
  ADD COLUMN device_time timestamptz,             -- hora del dispositivo al enviar el lote
  ADD COLUMN clock_offset_seconds integer,        -- device_time - received_at (positivo = adelantado)
  ADD COLUMN clock_warning text CHECK (clock_warning IN ('SKEW', 'FUTURE'));

CREATE INDEX offline_operations_clock_idx ON offline_operations (site_id, received_at DESC)
  WHERE clock_warning IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS offline_operations_clock_idx;
ALTER TABLE offline_operations
  DROP COLUMN IF EXISTS clock_warning,
  DROP COLUMN IF EXISTS clock_offset_seconds,
  DROP COLUMN IF EXISTS device_time;
