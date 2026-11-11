# Nexo App v2.0 — Backend (API REST)

API REST de Nexo App para el parqueadero Facaparking (Facatativá). La usa el frontend web en
[`../frontend`](../frontend). Stack: Node.js + Express 5, PostgreSQL (`pg`), Jest + Supertest.

## Requisitos

- Node.js 18.18 o superior.

## Puesta en marcha

```bash
cd backend
npm install
cp .env.example .env   # completar los valores; .env nunca se sube al repositorio
npm run dev            # API en http://localhost:3000 (se reinicia al guardar cambios)
```

Para comprobar que responde: `curl http://localhost:3000/api/health` → `{"ok":true}`.

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Arranca la API con recarga automática (`node --watch`). |
| `npm start` | Arranca la API (producción). |
| `npm test` | Ejecuta las pruebas (Jest + Supertest). |

## Estructura

```
backend/
├── src/
│   ├── app.js          # arma la app Express (sin abrir el puerto; la usan las pruebas)
│   ├── server.js       # punto de entrada: abre el puerto HTTP
│   ├── config/         # lectura de variables de entorno
│   ├── routes/         # rutas por módulo, montadas bajo /api
│   ├── controllers/    # traducen HTTP ↔ servicios
│   ├── services/       # reglas de negocio
│   ├── middlewares/    # errores, 404 y (más adelante) autenticación
│   └── db/             # conexión a PostgreSQL
└── tests/              # pruebas de la API
```

## Variables de entorno

Ver [`.env.example`](.env.example). Ninguna credencial va en el código.
