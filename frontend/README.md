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

## Formatos

Todo en español de Colombia, en [`src/lib/format.js`](src/lib/format.js): montos `$ 130.000`,
fechas `05/03/2026` y hora `2:05 p. m.`.
