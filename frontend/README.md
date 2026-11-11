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
| Resto del menú | Aviso provisional con la fase en que se construye | Según el menú |

## Sesión

- El JWT de acceso vive solo en memoria; la sesión se recupera al recargar gracias a la cookie
  httpOnly que pone la API. Si el JWT vence, [`src/lib/api.js`](src/lib/api.js) lo renueva y
  repite la petición.
- [`IdleGuard`](src/components/IdleGuard.jsx) cierra la sesión por inactividad (15 min operador,
  30 min administradores; el tiempo lo envía la API), avisa un minuto antes y comparte la actividad
  entre pestañas. Cerrar sesión en una pestaña la cierra en todas.

## Recibos

El recibo térmico de 50 mm (área útil 48 mm) se imprime con `window.print()`: [`styles/receipt.css`](src/styles/receipt.css)
define `@page { size: 50mm auto }` y en `@media print` solo deja visible el recibo. Lleva un QR (librería
`qrcode`) hacia el portal del cliente.

## Formatos

Todo en español de Colombia, en [`src/lib/format.js`](src/lib/format.js): montos `$ 130.000`,
fechas `05/03/2026` y hora `2:05 p. m.`.
