# Publicar Nexo.app en un servidor (VPS)

Esta guía deja la app **en internet, con HTTPS**, para que cualquier cliente abra el portal desde su
celular, sin depender de tu computador ni de tu Wi-Fi.

Qué se levanta (todo con un solo comando, con Docker):

| Servicio | Qué hace |
|---|---|
| `db` | PostgreSQL 16. **No se expone a internet.** |
| `api` | El backend de Nexo. Aplica las migraciones al arrancar. |
| `web` | Caddy: sirve la app, reenvía `/api` y el tiempo real a la API y **saca el certificado HTTPS solo**. |

> **Importante: estos archivos no se han podido probar en un servidor real** (el equipo de desarrollo
> no tiene Docker). Siga la guía con calma y, si algo falla, mire `docker compose logs`.

---

## 0. Lo que necesitas antes

1. **Una cuenta en un proveedor de servidores** (Hetzner, DigitalOcean, Vultr, etc.) y una tarjeta. Esto
   lo haces tú. Un servidor pequeño basta: **2 GB de RAM, 1 CPU, Ubuntu 24.04** (unos 5 a 10 USD al mes;
   confirma el precio actual en el sitio del proveedor).
2. **El código en GitHub.** El servidor baja el código de ahí, así que la rama que quieras publicar
   (hoy `v2-portalcliente`) debe estar subida a `origin`.
3. (Opcional) **Un dominio** (por ejemplo `portal.facaparking.com`). Si todavía no tienes, la guía
   funciona con un nombre gratis que da la IP del servidor (ver el paso 3).

## 1. Crear el servidor

1. Crea un servidor **Ubuntu 24.04** con tu llave SSH (o contraseña).
2. Anota su **IP pública**, por ejemplo `203.0.113.10`.
3. Conéctate: `ssh root@203.0.113.10`

## 2. Preparar el servidor (una sola vez)

```bash
apt update && apt upgrade -y
# Firewall: solo SSH, web y HTTPS
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
# Docker
curl -fsSL https://get.docker.com | sh
# Reinicio automático de seguridad y zona horaria
timedatectl set-timezone America/Bogota
```

## 3. Bajar el código y configurar

```bash
git clone https://github.com/valebasic/Parqueadero.git
cd Parqueadero
git checkout v2-portalcliente        # la rama que vas a publicar
cd deploy
cp .env.example .env
nano .env                            # completar (ver abajo)
```

> Si el repositorio es **privado**, `git clone` pedirá usuario y un *token* de GitHub (Settings →
> Developer settings → Personal access tokens, con permiso de lectura del repositorio).

**Qué completar en `.env`:**

- **`SITE_ADDRESS` y las direcciones:**
  - Con dominio: crea un registro DNS tipo **A** que apunte a la IP del servidor y pon
    `SITE_ADDRESS=portal.midominio.com`, `PORTAL_URL=https://portal.midominio.com`,
    `CORS_ORIGIN=https://portal.midominio.com`.
  - **Sin dominio:** usa la IP con guiones y `.sslip.io`. Para la IP `203.0.113.10`:
    `SITE_ADDRESS=203-0-113-10.sslip.io`, `PORTAL_URL=https://203-0-113-10.sslip.io`,
    `CORS_ORIGIN=https://203-0-113-10.sslip.io`.
    (sslip.io es un servicio gratuito de terceros que convierte la IP en un nombre; sirve para
    empezar, pero para el negocio conviene tener dominio propio.)
- **Claves** (genera cada una distinta):
  ```bash
  openssl rand -base64 24    # DB_PASSWORD
  openssl rand -base64 48    # JWT_SECRET (mínimo 32 caracteres)
  ```
- `SEED_ADMIN_PASSWORD`: la contraseña inicial del administrador **Felipe** (mínimo 8).
- Correo (Gmail con contraseña de aplicación), `GEMINI_API_KEY` y, si quieres, el SMS.
- **Wompi: déjalo vacío por ahora.** Con las llaves de Wompi vacías, el pago en línea queda
  **apagado**: el portal solo consulta y manda al cliente a pagar en el parqueadero, y los avisos de
  mensualidad dicen "acérquese al parqueadero" sin enlace de pago.

> **Elige bien la dirección antes de imprimir tiquetes.** El QR de cada tiquete lleva `PORTAL_URL`
> para siempre. Si después cambias de dirección, los tiquetes ya impresos dejarán de funcionar.

## 4. Levantar todo

```bash
docker compose up -d --build         # la primera vez tarda varios minutos
docker compose ps                    # los tres servicios deben decir "running"/"healthy"
docker compose logs -f api           # debe decir: "Nexo API escuchando en http://localhost:3000 (production)"
```

Crear los datos iniciales (la sede, las tarifas, el plano y el usuario **Felipe**). Se hace **una sola vez**:

```bash
docker compose exec api node src/db/seed.js
```

Abre `https://TU-DIRECCION` en el navegador. La primera vez Caddy tarda unos segundos en obtener el
certificado. Entra con el usuario `Felipe` y la contraseña de `SEED_ADMIN_PASSWORD`, y **cámbiala**
desde "Mi cuenta".

## 5. Comprobar que quedó bien

- `https://TU-DIRECCION/api/health` debe responder `{"ok":true}`.
- El candado de HTTPS aparece en el navegador.
- Crea una entrada de prueba y escanea el QR del tiquete con un celular **con datos móviles** (sin
  Wi-Fi): debe abrir el portal.
- Pide el código de una mensualidad de prueba: el correo debe llegar.

## 6. Actualizar a una versión nueva

```bash
cd ~/Parqueadero && git pull
cd deploy && docker compose up -d --build   # las migraciones se aplican solas al arrancar
```

## 7. Respaldos

- La API hace un respaldo diario a las `BACKUP_HOUR` (por defecto 2 a. m.) y guarda los últimos
  `BACKUP_KEEP` en `deploy/backups/`.
- **Cópialos fuera del servidor**, porque si el servidor se pierde se pierden también. Por ejemplo, desde
  tu computador: `scp -r root@IP:~/Parqueadero/deploy/backups .`
- Restaurar un respaldo en una base vacía:
  ```bash
  docker compose exec -T db pg_restore -U nexo -d nexo --clean --if-exists < backups/nexo-AAAAMMDD-HHMMSS.dump
  ```

## 8. Datos de la v1.0

Para pasar los datos del sistema anterior, mira el procedimiento en `PENDIENTES.md` (sección de
migración con `npm run migrate:v1`). Se ejecuta dentro del contenedor:
`docker compose exec api node scripts/migrate-v1.js archivo.json --dry-run`
(copia antes el archivo JSON al servidor).

## 9. Cuando tengas dominio o cuenta de Wompi

- **Dominio:** crea el registro A, cambia `SITE_ADDRESS`, `PORTAL_URL` y `CORS_ORIGIN` en `.env` y
  ejecuta `docker compose up -d`. Los QR de los tiquetes nuevos usarán la dirección nueva.
- **Wompi:** llena las cuatro llaves en `.env` y ejecuta `docker compose up -d`. En el panel de Wompi
  configura la URL de eventos: `https://TU-DIRECCION/api/portal/wompi/webhook`.

## 10. Seguridad (resumen)

- Solo se abren los puertos 22, 80 y 443. PostgreSQL y la API no son accesibles desde internet.
- El archivo `deploy/.env` guarda todas las claves: no lo subas a git ni lo compartas.
- Cambia las claves que se hayan pegado en conversaciones o chats durante el desarrollo
  (contraseña de PostgreSQL, Auth Token de Twilio, clave de Gemini, contraseña de aplicación de Gmail).
- Mantén el servidor al día: `apt update && apt upgrade -y` de vez en cuando.

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| No abre la página | `docker compose ps` y `docker compose logs web` (¿el certificado? ¿el DNS apunta a la IP?) |
| Error 502 | `docker compose logs api`: casi siempre falta una variable en `.env` |
| "JWT_SECRET debe tener al menos 32 caracteres" | Revisa `JWT_SECRET` en `.env` |
| El correo no sale | `docker compose logs api` y revisa `SMTP_USER` / `SMTP_PASS` |
| Sin respaldo | `docker compose logs api` y la carpeta `deploy/backups` |
