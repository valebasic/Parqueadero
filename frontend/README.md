# Nexo App v2.0 — Frontend web

Interfaz web de Nexo App (operador de sede y administradores). React + Vite + React Router.
Los colores y la estructura de pantallas siguen a la v1.0 (`assets/nexo-theme.css` y los `*.html`
de la raíz del repositorio).

## Requisitos

- Node.js 20.19 o superior (lo exige Vite 8).
- El backend corriendo (ver [`../backend/README.md`](../backend/README.md)).

## Puesta en marcha

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173
```

En desarrollo, Vite reenvía `/api` y `/socket.io` al backend (`http://localhost:3000` por defecto).
Si el backend corre en otra dirección, copiar `.env.example` a `.env` y cambiar `VITE_API_PROXY_TARGET`.

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo con recarga en caliente. |
| `npm run build` | Genera la versión de producción en `dist/`. |
| `npm run preview` | Sirve `dist/` para revisarla localmente. |

## Estructura

```
frontend/src/
├── App.jsx          # rutas
├── main.jsx         # arranque de React
├── components/      # menú lateral, barra superior, íconos, guardas de ruta
├── context/         # sesión del usuario
├── layouts/         # estructura común de las pantallas internas
├── lib/             # roles y menú, formatos (COP, dd/mm/aaaa, 12 h a. m./p. m.)
├── pages/           # pantallas
└── styles/          # tema visual (tokens de la v1.0) y layout responsivo
```

## Pantallas disponibles

| Ruta | Pantalla | Roles |
| --- | --- | --- |
| `/login` | Inicio de sesión contra la API | Todos |
| `/usuarios` | Usuarios: listar, crear, editar, desactivar y restablecer contraseña | AG, AS |
| `/cuenta` | Mi cuenta: datos y cambio de contraseña propia (desde el usuario en la barra superior) | Todos |
| `/entradas` | Entradas y salidas (como ParkApp.html): placa + Enter registra; cobro con descuento y forma de pago | Todos |
| `/caja` | Abrir, entregar o cerrar el turno con arqueo por denominación | Todos |
| `/ventas` | Ventas con filtros, reimpresión y cambio de forma de pago | Todos |
| `/pendientes` | Cobros pendientes y confirmación de pago | AG, AS |
| `/sedes` | Sedes y zonas (listado) | AG |
| `/` | Inicio: tablero de la sede (AG/AS) o accesos del turno (OP) | Todos |
| `/mensualidades` | Registro, pagos (único, quincenal, adelantado), importación CSV, historial | AG, AS |
| `/transacciones` | Ingresos, egresos y base (verde/rojo/naranja); edición el mismo día | Todos (OP con tope) |
| `/reportes` | KPIs, gráficas, efectivo vs electrónico, cierres, fidelidad, Excel/PDF | AG, AS |
| `/reportes-mensualidades` | Pagos FM, totales y cartera | AG, AS |
| `/conflictos` | Bandeja de conflictos de sincronización: aplicar o descartar con nota; pestaña "Advertencias de hora" (reloj del equipo desfasado > 10 min o con hora futura) | AG, AS |
| `/configuracion` | Tarifas con vigencia, datos del local, recibos con vista previa, respaldos (AG) | AG, AS |

## Sesión

- El JWT de acceso vive solo en memoria; la sesión se recupera al recargar gracias a la cookie
  httpOnly que pone la API. Si el JWT vence, [`src/lib/api.js`](src/lib/api.js) lo renueva y
  repite la petición.
- [`IdleGuard`](src/components/IdleGuard.jsx) cierra la sesión por inactividad (15 min operador,
  30 min administradores; el tiempo lo envía la API), avisa un minuto antes y comparte la actividad
  entre pestañas. Cerrar sesión en una pestaña la cierra en todas.

## Tiempo real

[`RealtimeContext`](src/context/RealtimeContext.jsx) abre una conexión Socket.IO con el token de la sesión,
se reconecta sola (renovando el token si venció) y muestra en la barra superior **En vivo** o
**Reconectando…**. Inicio, Entradas y el resumen del turno se actualizan solos con los eventos de la
sede (`useSiteEvents`). Si el servidor cierra la sesión, la app vuelve al login.

## Recibos

El recibo térmico de 50 mm (área útil 48 mm) se imprime con `window.print()`: [`styles/receipt.css`](src/styles/receipt.css)
define `@page { size: 50mm auto }` y en `@media print` solo deja visible el recibo. Lleva un QR (librería
`qrcode`) hacia el portal del cliente.

## Formatos

Todo en español de Colombia, en [`src/lib/format.js`](src/lib/format.js): montos `$ 130.000`,
fechas `05/03/2026` y hora `2:05 p. m.`.

## PWA y operación sin conexión

- **Service worker** (vite-plugin-pwa, `npm run build`): la app abre sin internet. La API nunca se
  guarda en el service worker. Para probarlo: `npm run build && npm run preview` (puerto 4173, con
  proxy a la API) y en DevTools → Network → "Offline".
- **Almacén local cifrado** ([`src/lib/offline/secureStore.js`](src/lib/offline/secureStore.js)):
  IndexedDB con la cola de operaciones y la copia local cifradas con AES-GCM. La clave se deriva de la
  contraseña con PBKDF2-SHA256 (310.000 iteraciones) al iniciar sesión; vive en memoria y en
  `sessionStorage` (sobrevive a recargar, no a cerrar el navegador). La contraseña nunca se guarda:
  solo un verificador PBKDF2 para desbloquear.
- **Sin conexión** ([`src/lib/offline/engine.js`](src/lib/offline/engine.js)): entradas y salidas
  (efectivo, electrónico o pendiente) contra la copia local; tarifa con
  [`src/lib/tariff.js`](src/lib/tariff.js) (igual a la del servidor); recibo provisional
  `FA-P-<dispositivo>-0001`. El resto de pantallas se deshabilita con un aviso.
- **Sesión**: si se cae internet con la sesión abierta, se sigue trabajando hasta 8 h. La inactividad
  bloquea la pantalla y se desbloquea con la contraseña (verificada en el equipo). Sin conexión no se
  puede iniciar una sesión nueva.
- **Sincronización** automática al volver la conexión, en orden, con progreso en la barra superior
  ("Sin conexión · N operaciones por sincronizar" / "Sincronizando X de Y"). Cada envío lleva la hora
  del equipo (`deviceTime`) para detectar relojes desfasados.
