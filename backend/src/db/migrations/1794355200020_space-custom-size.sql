-- Up Migration
-- Puestos de tamaño libre (ancho × alto en celdas) para planos de más resolución, p. ej. puestos de
-- moto más pequeños que uno de carro en el plano de Facaparking.
ALTER TABLE parking_spaces DROP CONSTRAINT IF EXISTS parking_spaces_width_check;
ALTER TABLE parking_spaces DROP CONSTRAINT IF EXISTS parking_spaces_height_check;
ALTER TABLE parking_spaces DROP CONSTRAINT IF EXISTS parking_spaces_check1;
ALTER TABLE parking_spaces DROP CONSTRAINT IF EXISTS parking_spaces_check2;
ALTER TABLE parking_spaces ADD CONSTRAINT parking_spaces_size_check CHECK (width BETWEEN 1 AND 20 AND height BETWEEN 1 AND 20);

-- Down Migration
ALTER TABLE parking_spaces DROP CONSTRAINT IF EXISTS parking_spaces_size_check;
ALTER TABLE parking_spaces ADD CONSTRAINT parking_spaces_width_check CHECK (width IN (1, 2));
ALTER TABLE parking_spaces ADD CONSTRAINT parking_spaces_height_check CHECK (height IN (1, 2));
ALTER TABLE parking_spaces ADD CONSTRAINT parking_spaces_check1 CHECK (width * height <= 2);
