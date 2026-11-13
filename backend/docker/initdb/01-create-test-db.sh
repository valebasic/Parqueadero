#!/bin/sh
# Se ejecuta solo la primera vez que se crea el volumen de datos.
# Crea la base de pruebas de integración (npm run test:db), con el mismo dueño que la principal.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE "${DB_NAME_TEST}" OWNER "${POSTGRES_USER}";
EOSQL
