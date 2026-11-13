# Nexo App v2.0 — Estado y pendientes para el equipo

Entrega de la versión web (backend Express + PostgreSQL en [`backend/`](backend), frontend React +
Vite en [`frontend/`](frontend)) que reemplaza a la v1.0 de Electron (archivos de la raíz, en `main`).
La documentación técnica detallada está en [`backend/README.md`](backend/README.md) y
[`frontend/README.md`](frontend/README.md); este archivo resume el estado, cómo arrancar y qué falta.

Cada pendiente tiene un issue en GitHub con las etiquetas `V3`, `V4`, `pruebas`, `despliegue` o
`documentación`.

## 1. Estado por vuelta de la ERS

| Vuelta | Requisitos | Estado | Rama / PR |
| --- | --- | --- | --- |
| Base (fases 1–7) | RF01–RF25 (seguridad, operación, mensualidades, caja, reportes, configuración, respaldos), RF41–RF43, RF60 y RF62 (sin conexión), RNF03, RNF12; migración desde la v1.0 | Hecho, con pruebas | `v2-web` → PR #1 hacia `main` |
| V1 | RF26–RF33 (panel multisede) y RF44–RF46 (turnos y horas trabajadas) | Hecho, con pruebas | `v2-web` (incluido en PR #1) |
| Valor agregado | NexoIA: asistente con Gemini portado de la v1.0 (solo lectura + propuestas que aprueba una persona) | Hecho, probado con Gemini simulado; **falta probar con una clave real** | `v2-web` (incluido en PR #1) |
| V2 | RF47–RF52 (mapa de espacios en tiempo real) + plano real de Facaparking en el seed + puestos que piden llaves | Hecho, con pruebas | `v2-mapa` → PR hacia `v2-web` |
| V3 | RF34–RF40 (lectura automática de placas) | **Parcial:** lectura con la cámara del equipo en Entradas (RF35, RF37), traída de la v1.0 web. Faltan cámaras IP, evidencia, monitoreo y listas | `v2-camara` → PR hacia `v2-mapa` |
| V4 | RF53–RF59 (portal del cliente) | **Pendiente** (solo existe el enlace del QR en los recibos) | — |

Otras ramas:

- `v1-exportador`: v1.0 versión 2.6.52 con el botón **Exportar todo a JSON** (Superadmin), necesario
  para migrar los datos de la v1.0. Parte de `main` y solo toca archivos de la v1.0. No tiene PR.
- `v2-backend` (solo local): quedó contenida en `v2-web`; se puede borrar.

RF61 no aparece referenciado en el código: confirmar en la ERS si quedó cubierto por la operación
sin conexión o si falta.

## 2. Cómo levantar el proyecto desde cero

Requisitos: Node.js 20.11 o superior, PostgreSQL 16 (Docker o instalado), Git.

### 2.1 Base de datos

**Opción A — Docker (recomendada)**

```bash
cd backend
npm install
cp .env.example .env        # completar DB_PASSWORD, JWT_SECRET y SEED_ADMIN_PASSWORD
npm run db:up               # PostgreSQL 16 en el contenedor nexo-postgres (crea también nexo_test)
```

**Opción B — PostgreSQL instalado en el equipo**

Crear el usuario y las dos bases **en UTF-8** (en Windows el instalador suele dejar WIN1252):

```sql
-- psql -U postgres
CREATE USER nexo WITH PASSWORD 'una-clave-segura';
CREATE DATABASE nexo      OWNER nexo ENCODING 'UTF8' TEMPLATE template0;
CREATE DATABASE nexo_test OWNER nexo ENCODING 'UTF8' TEMPLATE template0;
```

y poner esos datos en `backend/.env` (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
`DB_NAME_TEST`, o una `DATABASE_URL`). No hace falta `npm run db:up`.

### 2.2 Variables de entorno (`backend/.env`)

Todas están explicadas en [`backend/.env.example`](backend/.env.example). Las obligatorias:

| Variable | Para qué |
| --- | --- |
| `DB_*` o `DATABASE_URL` | Conexión a PostgreSQL (`DB_NAME_TEST` / `TEST_DATABASE_URL` para las pruebas) |
| `JWT_SECRET` | Firma de las sesiones; mínimo 32 caracteres, distinto en cada instalación |
| `SEED_ADMIN_PASSWORD` | Contraseña inicial del AG **Felipe** (cambiarla en el primer ingreso) |

Opcionales: `PORT`, `CORS_ORIGIN`, `APP_TIMEZONE`, `COOKIE_SECURE`, `TRUST_PROXY`,
`LOGIN_RATE_LIMIT_*`, `PORTAL_URL` (URL del QR de los recibos), `SEED_SITE_MAP` (1 = crear el plano
de Facaparking), `BACKUP_*` / `PG_DUMP_PATH` / `PG_DUMP_DOCKER_CONTAINER` (respaldos),
`GEMINI_API_KEY` / `GEMINI_MODEL` / `AI_RATE_LIMIT_*` (NexoIA). Nunca subir `.env` al repositorio.

Frontend: solo si el backend no está en `http://localhost:3000`, copiar
[`frontend/.env.example`](frontend/.env.example) a `.env` y cambiar `VITE_API_PROXY_TARGET`.

### 2.3 Tablas, seed y arranque

```bash
cd backend
npm run db:reset            # BORRA todo, aplica las 20 migraciones y carga el seed
#   (en una base con datos usar: npm run db:migrate && npm run db:seed)
npm run dev                 # API en http://localhost:3000  → GET /api/health = {"ok":true}

cd ../frontend
npm install
npm run dev                 # http://localhost:5173
```

El seed crea la sede **Facaparking** (código `FACA`), la zona **Principal** con su plano publicado
(36 puestos: 1–31 de carro, M1–M5 de moto y cicla), las tarifas de la v1.0 y el AG **Felipe**.
Se puede repetir sin duplicar. `SEED_SITE_MAP=0` omite el plano.

### 2.4 Pruebas

```bash
cd backend
npm test                    # 393 pruebas sin base de datos
npm run test:db             # 317 pruebas de integración contra la base de PRUEBAS (la recrea)
cd ../frontend && npm run build
```

### 2.5 Migración de los datos de la v1.0

Resumen (detalle en [backend/README.md › Migración desde la v1.0](backend/README.md#migración-desde-la-v10)):

1. En el equipo de la v1.0, **cerrar la caja** del día.
2. Instalar la v1.0 **2.6.52** (rama `v1-exportador`, `npm run dist`) encima de la instalada.
3. Entrar como Superadmin → Configuración → **Exportar todo a JSON**.
4. En la v2.0 (base migrada): `npm run migrate:v1 -- archivo.json --dry-run` y revisar el reporte.
5. Si cuadra: `npm run migrate:v1 -- archivo.json --reporte=migracion.json` (todo o nada, idempotente).
6. Cada usuario entra con su contraseña de la v1.0 (se re-hashea sola a bcrypt).
7. Borrar el archivo exportado (lleva los hashes de las contraseñas).

## 3. Orden recomendado de merge

Ninguno está mezclado todavía. Probado con `git merge-tree`: **ningún paso tiene conflictos**.

1. **PR `v2-mapa` → `v2-web`** (vuelta V2 + plano de Facaparking). Después de mezclarlo, el PR #1
   se actualiza solo con estos commits.
2. **PR #1 `v2-web` → `main`** (fases 1–7, V1 y NexoIA, ya con el mapa).
   `main` tiene 2 commits del asistente de la v1.0 (`11f65db`, `1a58701`) que `v2-web` no tiene;
   tocan solo archivos de la v1.0 (raíz, `agente/`, `AGENTE.md`) y la v2.0 solo agrega `backend/`
   y `frontend/`, por eso no chocan. Usar **merge commit** (no rebase ni squash) para conservar la
   historia de ambos.
3. **`v1-exportador` → `main`** (abrir PR): versión 2.6.52 de la v1.0 con el exportador. Parte de
   `main` y no choca con la v2.0. Hacerlo antes de migrar datos de producción.
4. Borrar `v2-backend` (local, ya contenida en `v2-web`) y, cuando todo esté en `main`, las ramas
   mezcladas.

Ver el pendiente 6 sobre cómo conviven la v1.0 y la v2.0 en `main`.

## 4. Pendientes

### 1. V4 — Portal del cliente (RF53–RF59) · `V4`

Portal público donde el cliente consulta su vehículo por placa.

- **Verificación** antes de mostrar datos: (a) QR del recibo o consecutivo + placa, o (b) código de
  un solo uso por SMS o correo al contacto de la mensualidad. Códigos de 6 dígitos con hash,
  vencimiento corto (p. ej. 10 min) y máximo de intentos; sesión del portal separada de la de los
  empleados (token propio, sin acceso a `/api/*` interno).
- **Consulta**: estancia actual (hora de entrada, tiempo, valor a la fecha) y mensualidad (vigencia,
  franja, pagos). Nunca mostrar datos de otros clientes ni de empleados.
- **Protección**: rate limit por IP y por placa + **Cloudflare Turnstile** validado en el servidor.
- **Pago**: **Wompi sandbox**; crear la transacción en el backend, confirmar **solo por webhook**
  (verificar la firma con el secreto de eventos, idempotente por id de transacción). El pago
  aprobado se registra como una venta o un abono normal (caja virtual/“portal” por sede).
- **Comprobante PDF** descargable del pago o de la estancia.

Reutilizar:

- [`receipts.service.js`](backend/src/services/receipts.service.js): `portalUrlFor` (el QR ya apunta a
  `${PORTAL_URL}/recibo?sede=&recibo=`) y `buildReceipt` para los datos del recibo.
- [`tariff.service.js`](backend/src/services/tariff.service.js) `calculateFare` y la cotización de
  salida de [`entries.service.js`](backend/src/services/entries.service.js) (`quoteExit`, `GET /api/entries/:id/quote`)
  para el valor a la fecha; nunca recalcular la tarifa en el portal.
- [`monthly.service.js`](backend/src/services/monthly.service.js) (vigencia, cobertura, abonos
  `monthly_payments`) y [`pending.service.js`](backend/src/services/pending.service.js).
- [`lib/plates.js`](backend/src/lib/plates.js) `normalizePlate` para la búsqueda.
- [`middlewares/rateLimit.js`](backend/src/middlewares/rateLimit.js) `createRateLimiter` (ya tiene
  clave configurable; está pensado para el portal, ver comentario RF57).
- [`lib/payments.js`](backend/src/lib/payments.js), [`sales.service.js`](backend/src/services/sales.service.js)
  y [`cash.service.js`](backend/src/services/cash.service.js) para registrar el pago en la caja.
- `pdfkit` (ya instalado; ver `toPdf` en [`export.service.js`](backend/src/services/export.service.js))
  para el comprobante.
- [`audit.service.js`](backend/src/services/audit.service.js) `recordAudit` para cada consulta
  verificada, pago y webhook.
- Frontend: rutas públicas nuevas (`/portal`, `/recibo`) fuera del layout autenticado en
  [`App.jsx`](frontend/src/App.jsx); `qrcode` ya está instalado.
- Variables nuevas en `.env.example`: `TURNSTILE_SECRET`, `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`,
  `WOMPI_EVENTS_SECRET`, `WOMPI_ENV=sandbox`, credenciales de SMS/correo.
- Pruebas: verificación (código vencido, intentos), aislamiento entre placas, webhook con firma
  válida/ inválida/ repetido, rate limit.

### 2. V3 — Lectura automática de placas (RF34–RF40) · `V3`

**Ya hecho (rama `v2-camara`):** lectura con la webcam del equipo en Entradas, en el navegador (Tesseract),
con registro automático cancelable y apertura de la salida si el vehículo ya está adentro. Ver
[`frontend/README.md`](frontend/README.md#lectura-de-placas-por-cámara). Sirve para operar ya con una
cámara USB; lo de abajo es para cámaras IP y la versión completa del requisito.

- **Servicio aparte en Python** (p. ej. `lpr/` con FastAPI): detección de la placa con **YOLO** y
  lectura con **OCR**; formato colombiano (carro `ABC123`, moto `ABC12D`). Probar **primero con un
  banco de imágenes y videos de placas colombianas** (día, noche, lluvia, ángulos) y medir la
  precisión antes de conectar cámaras.
- **Registro de cámaras** por sede y zona (entrada/salida, URL RTSP o subida de imagen); credenciales
  de la cámara fuera del código.
- **Umbral de confianza 90 %**: por encima propone la entrada/salida; por debajo exige
  **validación manual** del operador (confirmar o corregir la placa). Nunca registrar sin turno abierto.
- **Evidencia fotográfica**: guardar la imagen de cada lectura (almacenamiento con retención) y
  enlazarla a la entrada/salida.
- **Monitoreo de cámaras**: latido periódico; si una cámara deja de responder, alerta.
- **Listas de placas** (permitidas / bloqueadas / con aviso) por sede.

Reutilizar:

- [`entries.service.js`](backend/src/services/entries.service.js) `createEntry` y la salida: el
  servicio Python **no** escribe en la base; llama a la API (un endpoint nuevo con un token de
  dispositivo) y la API aplica las mismas reglas (tarifa, mensualidad, puesto del mapa con
  [`spaces.service.js`](backend/src/services/spaces.service.js) `assignForEntry`).
- `entries.origin` admite `ONLINE`, `OFFLINE`, `V1_IMPORT`: agregar `LPR` con una migración nueva
  (`npm run db:migrate:create -- lpr`), más la confianza y la referencia a la evidencia.
- [`lib/plates.js`](backend/src/lib/plates.js) `normalizePlate` / `detectVehicleType` / `plateError`.
- [`realtime/bus.js`](backend/src/realtime/bus.js) `publish(siteId, ...)` para mostrar la lectura
  pendiente de validar en la pantalla de Entradas.
- [`admin/alerts.service.js`](backend/src/services/admin/alerts.service.js) `raise` (con `key` y
  enfriamiento) para cámara caída y placa en lista bloqueada.
- [`audit.service.js`](backend/src/services/audit.service.js) para validaciones y correcciones manuales.
- Patrón de token de dispositivo: el token de sincronización de
  [`sync.service.js`](backend/src/services/sync.service.js) / `token.service.js`.

### 3. Pruebas que dependen de la hora real · `pruebas`

La prueba del histórico por hora (`maps.test.js`) fallaba si el archivo cruzaba un cambio de hora;
ya se corrigió (commit `6c03796`, usa un día fijo). Revisar el resto con el mismo criterio: hay
consultas con `now()`, `CURRENT_DATE`, `Date.now()` o `new Date()` en `ai`, `auth`, `clock`,
`conflicts`, `management`, `multisite`, `operation`, `realtime`, `schema`, `staff-alerts`, `sync` y
`users` (`tests/db/`), y en `auth-guard.test.js` y `tariff-v1.test.js`.

- Riesgos típicos: medianoche (rango "hoy"), cambio de hora, quincena/fin de mes en mensualidades,
  festivos y horas trabajadas, alertas por horario.
- Cómo: fechas fijas del pasado en los datos; pasar `now` como parámetro (ya lo hacen
  `alerts.service.evaluate(siteIds, now)` y `schedules.service.schedulesActiveAt(siteIds, at)`);
  `jest.useFakeTimers({ now })` en pruebas sin base; evitar `date_trunc(..., now())` en aserciones.
- Criterio de aceptación: la suite pasa con el reloj del sistema a las 23:59:30, a las HH:59:30 y
  el último día del mes (probar con una VM o `faketime`).

### 4. Probar NexoIA con una clave real de Gemini · `pruebas`

Las pruebas usan Gemini simulado ([`tests/db/ai.test.js`](backend/tests/db/ai.test.js)). Falta:
poner `GEMINI_API_KEY` (Google AI Studio) y confirmar el modelo `GEMINI_MODEL`; probar las preguntas
de AG/AS y OP, las herramientas de solo lectura, las propuestas (cambio de tarifa, etc.) y su
aprobación; verificar en los registros que **no** viajan nombres, teléfonos, documentos ni correos
([`src/ai/privacy.js`](backend/src/ai/privacy.js)); revisar el costo y el límite
`AI_RATE_LIMIT_*`. Código en [`backend/src/ai/`](backend/src/ai) (`gemini.js`, `agent.js`, `tools.js`).

### 5. Probar docker-compose y los respaldos en un equipo real · `pruebas` `despliegue`

El desarrollo se hizo con un PostgreSQL local; falta en un equipo con Docker:

- [`backend/docker-compose.yml`](backend/docker-compose.yml): `npm run db:up`, que se cree
  `nexo_test` ([`docker/initdb`](backend/docker/initdb)), zona horaria `America/Bogota`, y que los
  datos sobrevivan a `db:down`.
- Respaldos ([`backup.service.js`](backend/src/services/backup.service.js)): respaldo manual y
  programado (`BACKUP_HOUR`), retención `BACKUP_KEEP`, descarga desde la app, con `PG_DUMP_PATH`
  (PostgreSQL instalado) y con `PG_DUMP_DOCKER_CONTAINER=nexo-postgres`.
- **Restaurar** un respaldo en una base vacía con `pg_restore` y comprobar los datos (documentar el
  procedimiento en el README).

### 6. Merge de los PR a `main` y convivencia con la v1.0 · `despliegue`

Seguir el [orden de merge](#3-orden-recomendado-de-merge). Después decidir cómo conviven en `main`
la v1.0 (Electron en la raíz, con el asistente de los commits `11f65db` y `1a58701`) y la v2.0
(`backend/`, `frontend/`): p. ej. mover la v1.0 a `legacy/v1/` o dejarla en una rama `v1` y
etiquetar `v1-2.6.52`; actualizar el `README.md` de la raíz (hoy describe la v1.0) y el
`package.json` de la raíz para que no se confunda con la v2.0. El asistente de la v1.0 ya está
portado a la v2.0 como NexoIA.

### 7. Despliegue en un servidor (VPS) con HTTPS y dominio · `despliegue`

- VPS Linux con Node.js 20, PostgreSQL 16 (o el contenedor de Docker) y **nginx** como proxy inverso:
  sirve `frontend/dist` (con fallback a `index.html` para las rutas de React) y reenvía `/api` y
  `/socket.io` (con `Upgrade`/`Connection` para WebSocket) a la API. El backend **no** sirve el frontend.
- **HTTPS** con Let's Encrypt (certbot) y dominio propio; la PWA y la operación sin conexión exigen HTTPS.
- `.env` de producción: `NODE_ENV=production`, `JWT_SECRET` nuevo, `COOKIE_SECURE=true`,
  `TRUST_PROXY=1`, `CORS_ORIGIN=https://dominio`, `PORTAL_URL`, `BACKUP_*`.
- API como servicio (systemd o pm2) con reinicio automático; `npm run db:migrate` en cada versión
  (`db:reset` está bloqueado en producción).
- Respaldos copiados fuera del servidor; firewall (solo 80/443/SSH), PostgreSQL sin exponer.

### 8. Actualizar la ERS · `documentación`

- Pasar de aplicación **Electron** a **aplicación web** (PWA) con backend Node/PostgreSQL:
  arquitectura, despliegue, requisitos no funcionales.
- Agregar **NexoIA** como **valor agregado 6** (solo lectura, propuestas con aprobación humana,
  privacidad, auditoría).
- **Puestos que piden llaves** (islas que bloquean puestos de pared; registro de llaves recibidas y
  devueltas; se sugieren al final) y **puestos de tamaño libre** en el mapa.
- **Bandeja de conflictos sin conexión** (sincronización, ajuste de reloj y resolución por AS/AG).
- Confirmar el estado de RF61.
