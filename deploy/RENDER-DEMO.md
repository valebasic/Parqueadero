# Demo de Nexo.app en Render (gratis)

Para **mostrar la app funcionando en internet** (por ejemplo en una presentación), sin crear servidores.
**No es para clientes reales.** Los límites del plan gratis de Render (confírmalos en su sitio):
el servicio **se duerme tras ~15 minutos sin uso** y tarda ~30 segundos en despertar, y la base de datos
gratis **vence a los ~90 días**.

En este modo (`NODE_ENV=development`):
- El **pago de Wompi es simulado** (aparece el recuadro "Pago de PRUEBA"). No se cobra dinero.
- El **código de verificación del portal se muestra en pantalla** si no hay correo configurado.
- Un solo servicio entrega la web y la API, con HTTPS, y el QR de los tiquetes ya apunta a la dirección
  pública de Render (se toma sola, no hay que configurarla).

## Paso a paso

1. **Sube la rama a GitHub** (si no está): la rama `v2-portalcliente` con el archivo `render.yaml` en la raíz.
2. Crea una cuenta en https://render.com (puedes entrar con tu cuenta de GitHub).
3. En Render: **New + → Blueprint**. Conecta tu GitHub, elige el repositorio `Parqueadero` y la **rama**
   `v2-portalcliente`.
4. Render lee `render.yaml` y te pide los datos que no van en git:
   - **`SEED_ADMIN_PASSWORD`**: la contraseña del administrador **Felipe** (mínimo 8 caracteres). **Obligatoria.**
   - `GEMINI_API_KEY`: opcional (para NexoIA).
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`: opcionales (correo real). Para Gmail:
     `smtp.gmail.com`, `465`, tu correo, la contraseña de aplicación y `Nexo.app <tu correo>`.
     Sin correo, el código del portal se muestra en pantalla, y para una demo eso es lo más cómodo.
5. Pulsa **Apply / Create**. La primera compilación tarda unos **5 a 10 minutos**. Cuando el servicio diga
   **Live**, copia su dirección (algo como `https://nexo-xxxx.onrender.com`).
6. Abre la dirección. Entra con el usuario **`Felipe`** y la contraseña que pusiste.

## Antes de la presentación

- **Despiértalo 2 minutos antes**: abre la dirección y entra. Si lleva 15 minutos sin uso, la primera carga tarda.
- Crea la información de la demo: abre un turno, registra una entrada de prueba, y una mensualidad con celular
  y correo (marca la casilla de autorización de datos).
- Prueba el QR de un tiquete con un celular **con datos móviles**: debe abrir el portal.
- Ten a la mano el usuario y la contraseña de Felipe.

## Qué mostrar

1. **Entrada y salida** en Entradas, con el tiquete y su QR.
2. **Portal del cliente**: escanear el QR → ver el valor a la fecha → *Pagar* → pago de prueba aprobado → cuenta
   regresiva de 10 minutos → el operador ve "Pagó en el portal" al dar salida.
3. **Mensualidades**: consulta con código (se ve en pantalla) y renovación en línea.
4. **Panel principal**: el botón del sobre para avisar a un cliente.

## Después de la demo

- Para **apagar**: en Render, entra al servicio y a la base de datos y elige *Delete* (o déjalos: el servicio gratis
  se duerme solo).
- Para uso real, mira `deploy/README.md` (servidor propio con HTTPS) y usa llaves reales de Wompi.

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| El build falla | En Render, pestaña **Logs**: busca la primera línea en rojo y envíamela |
| "JWT_SECRET debe tener al menos 32 caracteres" | Render lo genera solo; revisa en *Environment* que exista `JWT_SECRET` |
| Pide contraseña y no entra | Es la que pusiste en `SEED_ADMIN_PASSWORD`; si la cambiaste después, hay que borrar la base y volver a crear |
| Tarda mucho al abrir | El servicio estaba dormido: espera ~30 segundos |
