-- Up Migration
-- Mapa de Facaparking: puestos que piden llaves, sentido de parqueo y puestos de moto y cicla.
--
--   requires_keys  el puesto bloquea a otros (isla frente a puestos de pared): al asignarlo se piden
--                  las llaves del vehículo y la entrada guarda si se recibieron y quién las recibió.
--   facing         lado del puesto que mira hacia la vía (parqueo en reversa: el frente del carro
--                  queda hacia ese lado). N, S, E u W; NULL = sin indicar.
--   MOTORCYCLE_BICYCLE  puesto que sirve para moto o cicla.

ALTER TABLE parking_spaces DROP CONSTRAINT IF EXISTS parking_spaces_space_type_check;
ALTER TABLE parking_spaces ADD CONSTRAINT parking_spaces_space_type_check
  CHECK (space_type IN ('CAR', 'MOTORCYCLE', 'BICYCLE', 'MOTORCYCLE_BICYCLE', 'REDUCED_MOBILITY'));
ALTER TABLE parking_spaces
  ADD COLUMN requires_keys boolean NOT NULL DEFAULT false,
  ADD COLUMN facing text CHECK (facing IN ('N', 'S', 'E', 'W'));

ALTER TABLE entries
  ADD COLUMN keys_received    boolean,        -- NULL = el puesto no pide llaves
  ADD COLUMN keys_received_by integer REFERENCES users (id),
  ADD COLUMN keys_received_at timestamptz,
  ADD CONSTRAINT entries_keys_check CHECK (
    (keys_received IS TRUE) = (keys_received_by IS NOT NULL AND keys_received_at IS NOT NULL)
  );

-- Down Migration
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_keys_check;
ALTER TABLE entries DROP COLUMN IF EXISTS keys_received_at, DROP COLUMN IF EXISTS keys_received_by, DROP COLUMN IF EXISTS keys_received;
ALTER TABLE parking_spaces DROP COLUMN IF EXISTS facing, DROP COLUMN IF EXISTS requires_keys;
ALTER TABLE parking_spaces DROP CONSTRAINT IF EXISTS parking_spaces_space_type_check;
ALTER TABLE parking_spaces ADD CONSTRAINT parking_spaces_space_type_check
  CHECK (space_type IN ('CAR', 'MOTORCYCLE', 'BICYCLE', 'REDUCED_MOBILITY'));
