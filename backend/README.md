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
cp .env.example .env     # completar DB_PASSWORD, JWT_SECRET y SEED_ADMIN_PASSWORD
npm run db:up            # levanta PostgreSQL 16 en Docker (usa los DB_* del .env)
npm run db:reset         # crea las tablas y carga el seed
npm run dev              # API en http://localhost:3000
```

Comprobar: `curl http://localhost:3000/api/health` → `{"ok":true}`. El resto de la API exige
sesión: ingresar como **Felipe** con la contraseña de `SEED_ADMIN_PASSWORD` y cambiarla desde
"Mi cuenta" en el primer ingreso.

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
| `npm run migrate:v1 -- archivo.json [--dry-run]` | Migra los datos de la v1.0 (ver [Migración desde la v1.0](#migración-desde-la-v10)). |

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
| `cash_counts` | Arqueos por denominación: apertura, entrega y cierre de turno |
| `user_sessions` | Sesiones: hash del token de la cookie, última actividad, vencimiento y revocación |
| `cash_movements` | Movimientos de caja: `INCOME` (ingreso), `EXPENSE` (egreso), `BASE_IN` (base +), `BASE_OUT` (base −) |
| `entries` | Entradas y salidas; una salida cobrada es una venta de parqueadero |
| `monthly_plans` | Mensualidades |
| `monthly_payments` | Pagos de mensualidad |
| `pending_charges` | Cargos pendientes (p. ej. mensualidad nocturna fuera de franja) |
| `audit_log` | Auditoría de acciones sensibles (solo inserción) |
| `offline_operations` | Operaciones hechas sin conexión (idempotentes por UUID), con su reloj y conflictos |
| `v1_import_map`, `v1_import_runs` | Migración desde la v1.0: qué registro v1 quedó en qué id v2 y el reporte de cada corrida |

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
│   ├── db/              # conexión, migraciones, seed y reset
│   └── migration/v1/    # importador de datos de la v1.0 (npm run migrate:v1)
├── scripts/             # migrate-v1.js (consola)
└── tests/               # pruebas de la API; tests/db/ = integración con PostgreSQL
```

## Seguridad (RF01-RF06)

- **Contraseñas**: bcrypt con costo 12. Política: mínimo 8 caracteres, con letras y números.
- **Login**: `POST /api/auth/login` devuelve un **JWT de acceso** de 5 minutos (el frontend lo guarda
  solo en memoria) y deja una **cookie de sesión** `nexo_rt` (httpOnly, SameSite=Strict, ruta
  `/api/auth`; Secure en producción) con un token aleatorio cuyo hash se guarda en `user_sessions`.
- **Renovación**: `POST /api/auth/refresh` entrega un JWT nuevo con la cookie. El frontend lo pide
  cuando el JWT vence y, mientras el usuario está activo, cada ~2 minutos.
- **Cierre por inactividad**: 15 min para OP y 30 min para AS y AG. Lo hace cumplir **el servidor**:
  cada petición revisa `last_activity_at` de la sesión y, si se pasó el límite, la revoca y responde
  `401 SESSION_IDLE` (ni el refresh la revive). Las peticiones automáticas pueden enviar
  `X-Nexo-Background: 1` para no contar como actividad. El frontend además avisa un minuto antes y
  cierra la sesión en todas las pestañas. Una sesión dura como máximo `SESSION_MAX_HOURS` (12 h).
- **Bloqueo**: 5 intentos fallidos seguidos bloquean la cuenta 5 minutos (`423 ACCOUNT_LOCKED`),
  aunque luego se escriba la contraseña correcta. Restablecer la contraseña desbloquea.
- **Autorización**: todo lo que se monta después de `authenticate` en
  [`src/routes/index.js`](src/routes/index.js) exige sesión (solo `/health` y `/auth/*` quedan
  antes). El rol y las sedes se leen de la base en cada petición, así que un cambio de permisos o una
  desactivación rige de inmediato. Rol incorrecto o sede ajena → `403` (y queda en auditoría).
- **Usuarios**: el AG gestiona a todos; el AS solo operadores de sus sedes y solo les asigna sus
  sedes (las sedes ajenas de un operador compartido se conservan). Nadie se desactiva a sí mismo ni
  cambia su propio rol, y no se puede desactivar ni quitar el rol al último AG activo. No se borran
  usuarios: se desactivan, y eso cierra sus sesiones.
- **Auditoría** (`audit_log`): `LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGIN_BLOCKED`, `ACCOUNT_LOCKED`,
  `LOGOUT`, `SESSION_IDLE_TIMEOUT`, `PASSWORD_CHANGED`, `PASSWORD_CHANGE_FAILED`, `USER_CREATED`,
  `USER_UPDATED`, `USER_DEACTIVATED`, `USER_ACTIVATED`, `USER_PASSWORD_RESET`, `ACCESS_DENIED`.
  Con IP y navegador; nunca contraseñas ni tokens.

Respuestas de error: `{ ok: false, error: "mensaje en español", code: "CODIGO" }`.

## Endpoints

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /api/health` | Público | Estado de la API: `{"ok":true}`. |
| `POST /api/auth/login` | Público | `{ username, password }` → JWT, perfil y cookie de sesión. |
| `POST /api/auth/refresh` | Cookie | JWT nuevo (cuenta como actividad). |
| `POST /api/auth/logout` | Cookie | Revoca la sesión y borra la cookie. |
| `GET /api/auth/me` | Con sesión | Perfil y datos de la sesión. |
| `PUT /api/auth/password` | Con sesión | `{ currentPassword, newPassword }`; cierra las demás sesiones. |
| `GET /api/sites` | Con sesión | AG: todas las sedes; AS y OP: las suyas. |
| `GET /api/sites/:siteId` | Con sesión | 403 si la sede no es del usuario. |
| `GET /api/users` | AG, AS | AG: todos; AS: operadores de sus sedes. |
| `POST /api/users` | AG, AS | `{ username, fullName, password, role, siteIds }`. |
| `GET /api/users/:id` | AG, AS | 403 si el AS no gestiona a ese usuario. |
| `PATCH /api/users/:id` | AG, AS | `fullName`, `role`, `siteIds`, `isActive`, `password` (restablecer). |
| `GET /api/shifts/current` | Con sesión | Turno abierto del usuario con el resumen de su caja (o `null`). |
| `GET /api/shifts/open?siteId=` | Con sesión | Turnos abiertos de la sede (zonas ocupadas, caja destino). |
| `POST /api/shifts` | Con sesión | Abrir turno: `{ zoneId, denominations }` (base contada). |
| `POST /api/shifts/:id/handover` | Dueño o AS/AG | Entrega: `{ denominations, withdrawal?: { amount, receivedBy }, outgoingPassword, incomingUsername, incomingPassword, notes }`. |
| `POST /api/shifts/:id/close` | Dueño o AS/AG | Cierre sin relevo: `{ denominations, notes, withdrawal? }`. |
| `GET /api/entries/lookup?siteId=&plate=` | Con sesión | Placa normalizada, tipo, si ya está adentro y mensualidad. |
| `GET /api/entries/open?siteId=` | Con sesión | Vehículos adentro de la sede. |
| `POST /api/entries` | Con turno | Entrada: `{ siteId, plate, vehicleType? }` → datos del tiquete. |
| `GET /api/entries/:id/quote` | Con sesión | Lo que se cobraría si sale ahora. |
| `POST /api/entries/:id/exit` | Con turno | Salida: `{ paymentMethod: CASH\|ELECTRONIC\|MIXED\|PENDING, cashAmount?, chargedAmount?, discountReason? }`. |
| `GET /api/entries/:id/receipt` | Con sesión | Datos del recibo. |
| `GET /api/sales?siteId=&from=&to=&q=&method=&page=` | Con sesión | Ventas (10 por página) con totales. |
| `PATCH /api/sales/:id/payment` | Ver abajo | Cambiar forma de pago (o a `PENDING`) con `reason` obligatorio. |
| `POST /api/sales/:id/reprint` | Con sesión | Reimpresión (queda en auditoría). |
| `GET /api/pending-charges?siteId=` | AG, AS | Pendientes agrupados por mensualidad o placa. |
| `POST /api/pending-charges/confirm` | AG, AS | `{ chargeIds, paymentMethod, cashAmount?, chargedAmount?, discountReason?, shiftId? }`. |

## Operación (RF07-RF12, RF19, RF41-RF43)

- **Turnos**: un turno abierto por zona y por usuario, cada uno con exactamente una caja. Se abre con
  la base contada por denominación (`cash_counts`). La **entrega** es una sola transacción: arqueo,
  contraseña de quien entrega y de quien recibe (los fallos cuentan para el bloqueo de 5 intentos),
  cierre de la caja y del turno, y apertura del turno nuevo en la misma zona con lo contado como base.
  El **cierre sin relevo** hace lo mismo sin turno nuevo. En ambos se puede registrar un **retiro** (efectivo entregado al administrador, con quién lo recibe) como movimiento "Base −"; el arqueo cuenta lo que queda en el cajón y eso es la base del turno nuevo. Sin turno abierto: `409 NO_OPEN_SHIFT` al
  registrar entradas, salidas o cobros.
- **Arqueo**: debe haber en el cajón = base del día + efectivo esperado (efectivo de ventas + ingresos
  − egresos). La diferencia (contado − debía haber) queda en la caja y en `cash_counts`.
- **Entradas**: placa con las reglas de `mvc/validators.js` ([`src/lib/plates.js`](src/lib/plates.js)),
  tipo deducido de la placa. Sin dos entradas abiertas (índice único parcial). Mensualidad vigente
  hasta 3 días después del vencimiento → `409 MONTHLY_ACTIVE`; nocturna fuera de su franja → entra
  vinculada y al salir el cobro va a Pendientes.
- **Salidas**: tarifa calculada en el servidor ([`tariff.service.js`](src/services/tariff.service.js),
  idéntica a `calculateTariff` de la v1.0: `tests/tariff-v1.test.js` la compara minuto a minuto contra
  el código original). Un valor cobrado menor es descuento con motivo obligatorio. La entrada se
  bloquea (`FOR UPDATE`): dos operadores no pueden cobrar la misma salida.
- **Recibos**: consecutivo por sede y prefijo en `receipt_counters` (sin repetidos ni huecos aunque
  registren varios a la vez). El QR apunta a `PORTAL_URL` (por ahora de ejemplo).
- **Ventas**: el AS/AG cambia la forma de pago de cualquier venta de sus sedes; el OP solo las de su
  caja abierta. Siempre con motivo y auditoría (`SALE_PAYMENT_CHANGED`, `RECEIPT_REPRINTED`).
- **Pendientes**: se confirman en grupo en una caja abierta (la propia o, para AS/AG, la de un turno
  de la sede); descuento y efectivo se reparten entre las salidas para que cada venta cuadre.
- **Límite por IP**: `POST /api/auth/login` admite 20 intentos cada 15 min por IP (`429 RATE_LIMITED`).
  [`createRateLimiter`](src/middlewares/rateLimit.js) sirve para el portal del cliente (RF57).

## Variables de entorno

Ver [`.env.example`](.env.example). Ninguna credencial va en el código.

## Mensualidades, caja, reportes y configuración (RF13-RF25)

- **Mensualidades** (`/api/monthly`, AG y AS): titular, teléfonos, correo, modalidad día/noche con franja,
  espacio y autorización de tratamiento de datos (obligatoria al registrar). Una placa no tiene dos
  vigentes (bloqueo por placa en la transacción). Registrar no cobra. Pago único o **quincenal** (2 abonos;
  el saldo se calcula sobre lo realmente cobrado; plazo del 2.º abono = inicio + 15 días). **Sin límite de
  mora**: el período siempre continúa desde el vencimiento anterior; la renovación se permite desde 1 día
  antes. **Pago adelantado en cola** (`next_period_*`): el nuevo período arranca solo en su fecha.
  **Importación CSV** con plantilla (`/api/monthly/import/template`): las filas válidas quedan "pendiente
  de confirmar pago" y se confirman una a una; las inválidas se informan con línea y motivo. Recibos con
  consecutivo **FM**; no pasan por caja. Reporte con totales y cartera; alertas rojo/amarillo/verde en Inicio.
- **Transacciones** (`/api/cash-movements`): ingresos, egresos y base +/−; editar solo el mismo día;
  la base nunca queda negativa; los movimientos de base de cajas cerradas y los retiros no se tocan. El OP
  registra ingresos y egresos de su caja, con tope por egreso (`sites.op_expense_limit`).
- **Inicio y reportes** (`/api/reports/*`, AG y AS): vehículos dentro, ocupación, ventas por forma de pago,
  alertas de mensualidades; KPIs y serie por hora / día / semana / mes según el rango; cierres de caja con
  detalle; fidelidad de clientes (puntaje de la v1.0); exportación `.xlsx` (exceljs) y PDF (pdfkit).
- **Configuración** (`/api/config/:siteId/*`, AG y AS): tarifas con vigencia (la abierta se cierra en la
  fecha de la nueva; se pueden programar a futuro y cancelar antes de que empiecen; el historial no se
  reescribe), datos del local, horario, tope de egresos del OP y edición de recibos (campos visibles,
  etiquetas, mensajes).
- **Respaldos** (`/api/backups`, solo AG): `pg_dump -Fc` diario a `BACKUP_HOUR`, bajo demanda y descarga;
  conserva `BACKUP_KEEP`. Con Docker, `PG_DUMP_DOCKER_CONTAINER=nexo-postgres`. Restaurar:
  `pg_restore -d nexo --clean archivo.dump`.

## Tiempo real (RF28, RNF03)

Socket.IO en el mismo servidor y puerto (`/socket.io`; en desarrollo lo reenvía el proxy de Vite).

- **Autenticación**: el cliente envía su JWT de acceso en `auth.token`; se valida el token y la sesión
  en la base (como en la API). Sin sesión → `connect_error` (`AUTH_REQUIRED`, `TOKEN_EXPIRED`,
  `TOKEN_INVALID`, `SESSION_REVOKED`…). Los sockets no cuentan como actividad.
- **Salas por sede** (`site:<id>`): cada usuario solo recibe eventos de sus sedes (el AG, de todas).
- **Sesión revocada** (logout, inactividad, usuario desactivado, cambio o restablecimiento de
  contraseña): el servidor envía `session:ended` y desconecta. Además revalida las sesiones cada
  `REALTIME_REVALIDATE_MS` (60 s por defecto).
- **Eventos** (`event` con `{ siteId, type, payload, at }`): `entry:created`, `entry:exited`,
  `occupancy:changed`, `shift:opened`, `shift:closed`, `shift:handover`, `cash:movement`,
  `sales:changed`, `pending:changed`, `monthly:alerts` (al cambiar una mensualidad y cada 30 min).
- Los servicios publican en un bus en memoria (`src/realtime/bus.js`) **después** de confirmar la
  transacción. Con varias instancias de la API hay que agregar el adaptador de Redis de Socket.IO.

## Operación sin conexión (RF60, RF62, RNF12)

Solo para Entradas, en una sede con el turno **ya abierto** antes de perder internet.

- `GET /api/sync/snapshot?siteId=`: copia local (tarifas vigentes y futuras, mensualidades vigentes
  con su cobertura + 3 días de gracia, entradas abiertas y datos del recibo). El frontend la guarda
  cifrada y la refresca con cada evento de tiempo real, al abrir turno y cada 5 min.
- `POST /api/sync/operations` `{ deviceId, operations: [{ id (UUID), seq, kind: ENTRY|EXIT, clientTs,
  provisionalReceipt?, data }] }`. Acepta el JWT de acceso o el **token de sincronización** (8 h, se
  entrega en login y refresh, solo sirve aquí y no depende de la inactividad; deja de servir si la
  sesión se revoca o el usuario se desactiva).
  - **Idempotente**: el UUID es la clave primaria de `offline_operations`; repetirlo devuelve el
    resultado guardado (`duplicate: true`), también si llegan dos envíos a la vez.
  - Se aplican en orden, cada una en su transacción. Entrada y salida usan la **hora del dispositivo**
    (si está en el futuro, la del servidor).
  - **Consecutivo**: el FA definitivo se asigna al sincronizar, en orden y sin huecos (un conflicto no
    consume número); el provisional `FA-P-<dispositivo>-0001` queda en `entries.provisional_receipt`.
  - **Tarifa**: el servidor la recalcula; si difiere de la del dispositivo registra
    `OFFLINE_TARIFF_DIFFERENCE` en auditoría y **no cambia lo cobrado**.
  - **Conflictos** (se guardan con `status = CONFLICT`, se auditan y nunca se descartan en silencio):
    `PLATE_OPEN_ELSEWHERE`, `PLATE_ALREADY_INSIDE`, `MONTHLY_ACTIVE`, `ALREADY_EXITED`,
    `ENTRY_IN_CONFLICT`, `REGISTER_CLOSED`, `SHIFT_INVALID`, `INVALID`.
- **Reloj del dispositivo**: el lote trae `deviceTime` (hora del equipo al enviar) y el servidor guarda
  `received_at` (su hora de recepción), `device_time` y `clock_offset_seconds`. Si el reloj difiere más
  de **10 minutos** (`clock_warning = SKEW`) o la operación tiene hora **futura** respecto a la
  recepción (más de 1 min, `FUTURE`), se registra `OFFLINE_CLOCK_SKEW` en auditoría y aparece como
  advertencia en la bandeja. **No bloquea el cobro**: la operación se aplica igual.
- **Bandeja de conflictos** (AS y AG): `GET /api/sync/conflicts?siteId=&status=open|resolved|clock` y
  `POST /api/sync/conflicts/:id/resolve` `{ action: 'apply' | 'discard', note, shiftId? }`. La nota es
  obligatoria y todo queda en auditoría (`OFFLINE_CONFLICT_RESOLVED`). Aplicar se hace a nombre del
  operador que hizo la operación: anula la otra entrada abierta (placa duplicada), registra la entrada
  normal (mensualidad), reintenta una salida cuya entrada ya se resolvió o lleva el cobro a la caja del
  turno abierto indicado (caja cerrada). `ALREADY_EXITED`, `INVALID` y `SHIFT_INVALID` solo se
  descartan. Dos administradores no pueden resolver el mismo conflicto.

## Migración desde la v1.0

Pasa los datos de la v1.0 (Electron, todo en `localStorage`) a esta base. Dos piezas:

1. **Exportador** (en la v1.0, rama `v1-exportador`, versión 2.6.52): Configuración → **Exportar todo a
   JSON**, solo para Superadmin. Descarga una copia literal de todas las claves de `localStorage` en
   `{ format: 'nexo-v1-export', formatVersion: 1, appVersion, exportedAt, exportedBy, keys }`. No
   modifica nada. (Se descartó leer el LevelDB de `%APPDATA%` con un script: depende de la versión de
   Chromium, exige cerrar la app y es frágil; el botón usa la misma API con la que la app guarda.)
2. **Importador**: `npm run migrate:v1 -- archivo.json [--dry-run] [--sede=FACA] [--reporte=r.json]`
   ([`scripts/migrate-v1.js`](scripts/migrate-v1.js), lógica en [`src/migration/v1/`](src/migration/v1)).
   Acepta también un volcado plano `{ "fp_entries": "...", ... }`.

### Cómo se mapea

| v1.0 (`localStorage`) | v2.0 |
| --- | --- |
| `fp_users` | `users` (+ `user_sites` para AS/OP). Superadmin→AG, Administrador→AS, Empleado→OP. Usuario saneado a `^[A-Za-z0-9._-]{3,40}$` (`José Ñúñez` → `Jose.Nunez`). Si ya existe en la v2.0 (p. ej. Felipe) se conserva la cuenta actual. |
| contraseña `salt:sha256` | `users.legacy_password_hash` tal cual (texto plano de instalaciones viejas: se convierte a ese formato). En el **primer login correcto** se verifica con SHA-256 + salt, se re-hashea con bcrypt y se borra el legacy (`PASSWORD_REHASHED`). |
| cuentas por defecto (`admin`/`admin`, `Felipe`/clave de fábrica) | se importan **desactivadas** |
| `fp_config` | `sites` (nombre, NIT, teléfono, dirección, capacidad, prefijos, horario) y `sites.receipt_config` |
| `fp_services` | `rates`: si cambió, se cierra la vigente y se crea una nueva desde ahora |
| `facaparking_offline_receipt_v4`, `…_monthly_v1`, `nextReceiptNumber*` | `receipt_counters` (FA/FM): el mayor entre la v1.0 y lo importado (nunca baja) |
| `fp_cash_closings` (y `fp_closures`) | `shifts` + `cash_registers` cerrados, con el resumen de la v1.0 en `summary` |
| `fp_entries` + `fp_entries_archive` | `entries` (`origin = V1_IMPORT`): PAID (venta), PENDING_CHARGE o OPEN; fechas `dd-mm-aaaa` en hora de Colombia |
| `fp_monthly_extra_charges` | `pending_charges` (abiertos o ya confirmados con su caja) |
| `fp_monthly` | `monthly_plans` (`origin = V1_MIGRATION`, sin autorización de datos: se pide en la primera renovación) |
| `fp_monthly_payments` | `monthly_payments` (abono quincenal 1/2, adelantado). Si su mensualidad se borró en la v1.0, se reconstruye como eliminada |
| `fp_incomes`, `fp_expenses`, `fp_base_in`, `fp_base_out` | `cash_movements` (INCOME, EXPENSE, BASE_IN, BASE_OUT) en la caja de su cierre |

Reglas: una venta "Sin método" se importa como electrónico (la caja v1 no la contaba como efectivo);
un descuento sin motivo recibe un motivo genérico; lo de la caja que seguía **abierta** en la v1.0 se
rechaza (hay que cerrarla y exportar de nuevo). Lo que la v1.0 no atribuye (quién registró una entrada)
queda a nombre del usuario de sistema `migracion.v1` (desactivado).

### Garantías

- **Todo o nada**: una sola transacción. `--dry-run` hace todo y revierte.
- **Cuadre**: por categoría (ventas, pendientes, vehículos adentro, mensualidades, pagos, ingresos,
  egresos, base ±, cierres y usuarios) compara conteo y total COP de la base **antes → después** con lo
  importado. Si algo no cuadra, se revierte completa (código de salida 2).
- **Idempotente**: `v1_import_map` (sede, entidad, id v1). Repetirla, o correr una exportación
  posterior, solo agrega lo nuevo.
- **Reporte**: conteos y totales en archivo / importados / omitidos / rechazados, la base antes y
  después, la lista de rechazados con su motivo y las advertencias. Cada corrida real queda en
  `v1_import_runs` y en auditoría (`V1_IMPORT`).

### Pasos (para quien hace la migración)

1. En el equipo de la v1.0: **cerrar la caja** del día.
2. Instalar la v1.0 **2.6.52** (`npm run dist` en la rama `v1-exportador`) **encima** de la instalada:
   los datos no se pierden (viven en `%APPDATA%`).
3. Entrar como **Superadmin** → Configuración → **Exportar todo a JSON** → guardar el archivo
   (`nexo-v1-export_AAAAMMDD_HHMM.json`) en una memoria USB.
4. En el servidor de la v2.0 (con la base migrada: `npm run db:migrate`):
   `npm run migrate:v1 -- ruta/al/archivo.json --dry-run` y revisar el reporte (rechazados y advertencias).
5. Si el reporte está bien: `npm run migrate:v1 -- ruta/al/archivo.json --reporte=migracion.json`.
6. Avisar a cada usuario que entre con **su misma contraseña de la v1.0** (se cambia sola a bcrypt) y
   pedir a los administradores que la cambien si era débil. Activar `admin` solo si hace falta,
   con una contraseña nueva.
7. Borrar el archivo exportado de la USB: lleva los hashes de las contraseñas.
