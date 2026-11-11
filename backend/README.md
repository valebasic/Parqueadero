# Nexo App v2.0 — Backend (API REST)

API REST de Nexo App para el parqueadero Facaparking (Facatativá). La usa el frontend web en
[`../frontend`](../frontend). Stack: Node.js + Express 5, PostgreSQL 16 (`pg` + `node-pg-migrate`),
bcrypt, Jest + Supertest.

## Requisitos

- Node.js 20.11 o superior (lo exige `node-pg-migrate`).
- PostgreSQL 16: con Docker (recomendado) o instalado en el equipo (ver más abajo).

## Puesta en marcha (con Docker)

```bash
cd backend
npm install
cp .env.example .env     # completar DB_PASSWORD y SEED_ADMIN_PASSWORD
npm run db:up            # levanta PostgreSQL 16 en Docker (usa los DB_* del .env)
npm run db:reset         # crea las tablas y carga el seed
npm run dev              # API en http://localhost:3000
```

Comprobar: `curl http://localhost:3000/api/health` → `{"ok":true}` y
`curl http://localhost:3000/api/sites` → la sede Facaparking con su zona.

El contenedor (`nexo-postgres`) guarda los datos en el volumen `nexo-pgdata`, así que sobreviven a
`npm run db:down`. Al crearse por primera vez también crea la base de pruebas (`DB_NAME_TEST`).
Para empezar de cero también con Docker: `docker compose down -v` (borra el volumen).

## Usar un PostgreSQL instalado en el equipo (sin Docker)

1. Instalar PostgreSQL 16 (en Windows, el instalador de EDB; en Linux, el paquete `postgresql-16`).
2. Crear el usuario y las dos bases **en UTF-8**. En Windows el instalador suele dejar WIN1252 por
   defecto: por eso se indica `ENCODING 'UTF8' TEMPLATE template0`. Desde `psql -U postgres`:

   ```sql
   CREATE USER nexo WITH PASSWORD 'una-clave-segura';
   CREATE DATABASE nexo      OWNER nexo ENCODING 'UTF8' TEMPLATE template0;
   CREATE DATABASE nexo_test OWNER nexo ENCODING 'UTF8' TEMPLATE template0;
   ```

3. Poner esos datos en `.env` (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
   `DB_NAME_TEST`) o, en su lugar, una `DATABASE_URL` completa.
4. Seguir con `npm run db:reset` y `npm run dev`. No hace falta `db:up`.

La primera migración se detiene con un mensaje claro si la base no está en UTF-8.

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Arranca la API con recarga automática (`node --watch`). |
| `npm start` | Arranca la API (producción). |
| `npm test` | Pruebas que no necesitan base de datos. |
| `npm run test:db` | Pruebas de integración contra la base de **pruebas** (la recrea antes de empezar). |
| `npm run db:up` / `db:down` | Levanta / detiene el PostgreSQL de Docker. |
| `npm run db:migrate` | Aplica las migraciones pendientes. |
| `npm run db:migrate:down` | Revierte la última migración (`node src/db/migrate.js down 3` revierte 3). |
| `npm run db:migrate:create -- nombre` | Crea un archivo de migración SQL nuevo. |
| `npm run db:seed` | Carga los datos iniciales (se puede repetir: no duplica). |
| `npm run db:reset` | **Borra todo**, aplica todas las migraciones y carga el seed. Bloqueado con `NODE_ENV=production`. |

## Base de datos

Migraciones SQL en [`src/db/migrations/`](src/db/migrations) (una sección `-- Up Migration` y otra
`-- Down Migration` por archivo). Equivalencias con los nombres del negocio:

| Tabla | Qué guarda |
| --- | --- |
| `sites` | Sedes (nombre, NIT, dirección, capacidad, prefijos de recibo) |
| `zones` | Zonas de cada sede |
| `users`, `user_sites` | Usuarios (rol AG, AS, OP) y las sedes asignadas a AS y OP |
| `rates` | Tarifas por sede y tipo de vehículo, con vigencia (`valid_from`, `valid_to`) |
| `receipt_counters` | Consecutivo de recibos por sede y prefijo (FA, FM) |
| `shifts` | Turnos (uno abierto por zona y por usuario) |
| `cash_registers` | Cajas (exactamente una por turno) |
| `cash_movements` | Movimientos de caja: `INCOME` (ingreso), `EXPENSE` (egreso), `BASE_IN` (base +), `BASE_OUT` (base −) |
| `entries` | Entradas y salidas; una salida cobrada es una venta de parqueadero |
| `monthly_plans` | Mensualidades |
| `monthly_payments` | Pagos de mensualidad |
| `pending_charges` | Cargos pendientes (p. ej. mensualidad nocturna fuera de franja) |
| `audit_log` | Auditoría de acciones sensibles (solo inserción) |

Convenciones:

- **Montos** en COP como enteros no negativos (tipo `money_cop`).
- **Placas** normalizadas: mayúsculas, sin espacios ni guiones (tipo `plate_number`).
- **Tipos de vehículo**: `CAR` (carro), `MOTORCYCLE` (moto), `BICYCLE` (cicla).
- **Formas de pago**: `CASH`, `ELECTRONIC`, `MIXED`; efectivo + electrónico siempre cuadra con el total.
- **Una placa no puede tener dos entradas abiertas**: índice único parcial `entries_one_open_per_plate`
  (carros y motos, en todas las sedes) y `entries_one_open_bicycle_per_site` (ciclas, que usan placas
  genéricas como `CICLA`, por sede).
- **Turnos (RF41/RF42)**: un solo turno abierto por zona (`shifts_one_open_per_zone`) y por usuario
  (`shifts_one_open_per_user`). Cada turno tiene exactamente una caja: el turno y su caja se crean en
  la misma transacción (un trigger diferido lo revisa al confirmar), un turno no se cierra con la caja
  abierta y las cajas no se borran.
- Las sesiones de PostgreSQL trabajan en hora de Colombia (`APP_TIMEZONE`).

### Seed

Sede **Facaparking** (código `FACA`) con la zona **Principal**, las tarifas de la v1.0 y el usuario
AG **Felipe**, cuya contraseña sale de `SEED_ADMIN_PASSWORD` en `.env` (mínimo 8 caracteres; si
Felipe ya existe, el seed no cambia su contraseña).

| Vehículo | Fracción | Hora | 12 h | Mensualidad |
| --- | ---: | ---: | ---: | ---: |
| Carro | $ 1.800 | $ 3.300 | $ 20.000 | $ 130.000 |
| Moto | $ 1.500 | $ 2.200 | $ 14.000 | $ 80.000 |
| Cicla | — | — | $ 10.000 | — |

Cada tarifa tiene un `pricing_mode`: `normal` (fracción/hora por bloques de 12 h, topado en la
tarifa plena, igual que `calculateTariff` de la v1.0) o `block12h` (tarifa plena por cada bloque de
12 h o fracción iniciado). La cicla usa `block12h`. El cálculo está en
[`src/services/tariff.service.js`](src/services/tariff.service.js).

## Estructura

```
backend/
├── docker-compose.yml   # PostgreSQL 16 para desarrollo
├── docker/initdb/       # crea la base de pruebas al iniciar el contenedor por primera vez
├── src/
│   ├── app.js           # arma la app Express (sin abrir el puerto; la usan las pruebas)
│   ├── server.js        # punto de entrada: abre el puerto HTTP
│   ├── config/          # lectura de variables de entorno
│   ├── routes/          # rutas por módulo, montadas bajo /api
│   ├── controllers/     # traducen HTTP ↔ servicios
│   ├── services/        # reglas de negocio y consultas
│   ├── middlewares/     # errores, 404 y (Fase 3) autenticación
│   └── db/              # conexión, migraciones, seed y reset
└── tests/               # pruebas de la API; tests/db/ = integración con PostgreSQL
```

## Endpoints

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/health` | Estado de la API: `{"ok":true}`. |
| `GET /api/sites` | Sedes con sus zonas. **Pendiente Fase 3:** exigir sesión y rol AG. |

## Variables de entorno

Ver [`.env.example`](.env.example). Ninguna credencial va en el código.
