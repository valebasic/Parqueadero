-- Up Migration
-- Retiro al entregar o cerrar un turno: efectivo que se le entrega al administrador.
-- Se registra como movimiento "Base -" (BASE_OUT) con el nombre de quien lo recibe.
ALTER TABLE cash_movements ADD COLUMN withdrawal_to text;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_withdrawal_check
  CHECK (withdrawal_to IS NULL OR (type = 'BASE_OUT' AND length(trim(withdrawal_to)) >= 3));

-- Down Migration
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_withdrawal_check;
ALTER TABLE cash_movements DROP COLUMN IF EXISTS withdrawal_to;
