-- Up Migration
-- Tipos y funciones compartidos por todas las tablas.

-- La base debe estar en UTF-8 (nombres con tildes, ñ, símbolos). Un PostgreSQL instalado en Windows
-- suele crear las bases en WIN1252; en ese caso hay que recrearla (ver backend/README.md).
DO $$
BEGIN
  IF getdatabaseencoding() <> 'UTF8' THEN
    RAISE EXCEPTION 'La base de datos usa la codificación % y debe ser UTF8. Créela con: CREATE DATABASE <nombre> ENCODING ''UTF8'' TEMPLATE template0;',
      getdatabaseencoding();
  END IF;
END
$$;

-- Necesaria para la restricción de exclusión de vigencias de tarifas (rates)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Montos en pesos colombianos: enteros, nunca negativos (el signo lo da el tipo de movimiento)
CREATE DOMAIN money_cop AS integer
  CHECK (VALUE >= 0);

-- Placa normalizada: mayúsculas, sin espacios ni guiones (igual que normalizePlate de mvc/validators.js)
CREATE DOMAIN plate_number AS text
  CHECK (VALUE ~ '^[A-Z0-9]{1,10}$');

-- Tipo de vehículo (v1.0: Carro, Moto, Cicla)
CREATE DOMAIN vehicle_type AS text
  CHECK (VALUE IN ('CAR', 'MOTORCYCLE', 'BICYCLE'));

-- Forma de pago (v1.0: Efectivo, Electrónico, Efectivo + Electrónico)
CREATE DOMAIN payment_method AS text
  CHECK (VALUE IN ('CASH', 'ELECTRONIC', 'MIXED'));

-- Mantiene updated_at al día en cada UPDATE
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Down Migration
DROP FUNCTION IF EXISTS set_updated_at();
DROP DOMAIN IF EXISTS payment_method;
DROP DOMAIN IF EXISTS vehicle_type;
DROP DOMAIN IF EXISTS plate_number;
DROP DOMAIN IF EXISTS money_cop;
DROP EXTENSION IF EXISTS btree_gist;
