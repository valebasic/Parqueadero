# Nexo.app (antes FacaParking) — Sistema de parqueadero offline

**Versión actual: 2.6.17** (la fuente de verdad es `"version"` en `package.json`;
`APP_VERSION` en `mvc/app-controller.js` y `package-lock.json` deben coincidir).

Aplicación de escritorio (Electron) para gestionar un parqueadero: entradas y
salidas de vehículos, mensualidades, caja diaria, ingresos y egresos, reportes
y recibos de impresora térmica. Funciona 100% offline, sin conexión a
internet.

Este README reemplaza a los más de 40 archivos `README_V*.txt` que existían
sueltos en el proyecto (uno por cada parche aplicado). Describe el **estado
vigente** de cada módulo, los riesgos conocidos y un changelog condensado al
final. Si el código y este documento se contradicen, gana el código: corrige el
README en el mismo cambio.

## Requisitos y ejecución

- Node.js 18 o superior (solo para desarrollar / generar el instalador).
- La app en sí no necesita internet para funcionar.

```bash
npm install     # instala Electron y electron-builder (solo la primera vez)
npm start       # abre la app en modo desarrollo
npm run dist    # genera el instalador .exe en la carpeta dist/
```

- El instalador queda en `dist/` con el nombre `Nexo.app Setup <versión>.exe`
  (por ejemplo, `Nexo.app Setup 2.6.17.exe`: la versión sale de `package.json`).
- El ícono ya está configurado: `package.json` → `build.win.icon` apunta a
  `icon.ico` (en la raíz del proyecto). Para cambiarlo, reemplazar ese archivo
  por un `.ico` de 256x256 y volver a correr `npm run dist`.

> **Dos bases de datos distintas.** La app instalada (`.exe`) y la que se abre
> en un navegador tienen cada una su propio `localStorage`. El archivo
> `Iniciar FacaParking Offline.bat` abre `login.html` **en el navegador
> predeterminado**, no en Electron; los datos que se registren ahí no aparecen
> en el `.exe` (y viceversa). Para operar usar siempre el `.exe` (o `npm
> start`). Si hay datos reales en el navegador, hay que exportarlos/importarlos
> antes de pasar a producción con el `.exe`.

## Arquitectura

- `main.js`: proceso principal de Electron. `nodeIntegration: false` y
  `contextIsolation: true` (configuración segura). Carga `login.html`.
- `mvc/model.js`: acceso a datos (`localStorage`), hash de contraseñas,
  normalización de método de pago y migración de la clave de entradas.
- `mvc/view.js`: helpers mínimos de presentación.
- `mvc/app-controller.js`: controladores, validaciones y flujo de cada
  pantalla (archivo grande, ~2.470 líneas — ver "Deuda técnica").
- `*.html`: una vista por pantalla: `login`, `index` (Inicio / dashboard),
  `ParkApp` (Entradas), `mensualidades`, `pendientes`, `caja`, `pagos`
  (Ventas), `egresos` (Transacciones: ingresos y egresos), `reportes`,
  `configuracion` y `registro`.
- El menú lateral se construye por código (`nav()` en el controlador), no con
  el HTML estático de cada página.
- Todo el almacenamiento es `localStorage` del proceso de Electron
  (independiente del `localStorage` de cualquier navegador).

> Nota: existió una rama de migración a SQLite (`README_SQLITE.md`, ahora
> eliminado) con un servidor local en Python. Esa migración **no** es la
> que está activa hoy: la app actual usa `localStorage` puro.

## Roles y permisos

Jerarquía: **Superadmin > Administrador > Empleado**.

| Pantalla | Empleado | Administrador | Superadmin |
| --- | --- | --- | --- |
| Inicio, Entradas, Cierre de Caja, Ventas | Sí | Sí | Sí |
| Mensualidades, Pendientes, Transacciones, Reportes, Configuración | No (no aparecen en el menú) | Sí | Sí |
| Historial de ingresos y Zona de peligro (Configuración) | No | No | Sí |
| Uso de almacenamiento (Configuración) | No | No | Solo el usuario `Felipe` |

- **Felipe** es la cuenta raíz: siempre tiene rol Superadmin (se normaliza en
  cada arranque), no se puede eliminar y solo puede editarse iniciando sesión
  como el propio Felipe.
- Solo un Superadmin puede crear, editar o eliminar otras cuentas Superadmin.
  Un Administrador ni siquiera ve las cuentas Superadmin en la tabla.
- Nadie puede eliminar su propia cuenta con la sesión abierta, y no se puede
  eliminar la única cuenta con privilegios de administración.
- Al eliminar un usuario también se quita de la lista de "usuarios
  recordados" del login.
- En Cierre de Caja el Empleado solo ve y registra el efectivo físico: no ve
  bases, ventas, efectivo esperado ni el detalle. En Mensualidades (si llegara
  a abrirla) no puede crear, editar, eliminar ni migrar, solo registrar pagos.
- **Pendiente de decidir:** `auth()` deja entrar al Empleado por URL a
  `mensualidades.html` y `egresos.html`, pero el menú se las oculta. En la
  práctica no puede llegar (Electron no tiene barra de direcciones), pero las
  dos reglas deberían coincidir.
- No hay cierre de sesión automático por inactividad: la sesión solo termina
  con "Salir".

## Estado vigente por módulo

### Login y usuarios
- Contraseñas guardadas con **SHA-256 + salt por usuario** (no texto
  plano). Instalaciones antiguas con texto plano se migran automáticamente
  al primer login exitoso.
- Selector de "usuarios recordados" (hasta 6) + entrada manual de
  usuario/contraseña.
- "¿Olvidaste tu contraseña?" no la recupera: indica que un Administrador
  debe restablecerla desde Configuración → Usuarios.
- `registro.html` existe pero **no hay ningún enlace que lleve a ella** desde
  la interfaz (el botón `goRegister` no está en `login.html`); crearía cuentas
  con rol Empleado.
- **Pendiente / riesgo:** no hay límite de intentos fallidos ni bloqueo
  temporal implementado en el código, aunque documentación antigua lo
  mencionaba. Si se necesita, hay que agregarlo.
- **Riesgo:** si no hay usuarios registrados, se crean automáticamente
  `Felipe / 259148637` (Superadmin) y `admin / admin` (Administrador).
  Cambiar esas contraseñas en cuanto se instale en un equipo nuevo.

### Entradas (ParkApp.html)
- Registro de entrada con placa, servicio (Carro/Moto/Cicla), consecutivo de
  recibo y hora de entrada tomada en el instante real del clic en "Registrar"
  (esta versión no trae opción para corregir manualmente la fecha/hora de
  entrada).
- Salida con cálculo de tarifa y **descuento**: una sola caja de texto donde
  se escribe el valor realmente cobrado (no hay selector porcentaje / valor).
  Requiere caja abierta.
- Una placa con mensualidad **vigente** bloquea la entrada normal (ver
  Mensualidades).

### Mensualidades
- Una placa no puede tener dos mensualidades vigentes a la vez, ni al crear ni
  al editar. La comparación ignora mayúsculas, espacios y guiones
  (`abc-123` = `ABC123`).
- Registrar una mensualidad **no cobra**: queda "pendiente de pago" y el pago
  se registra desde la lista. Mientras esté vigente (aunque no se haya pagado)
  bloquea la entrada normal de esa placa.
- Plazo de gracia: **3 días después del vencimiento** para poder registrar
  el pago (aplica igual a: renovación normal, primer pago de un registro
  nuevo, y segundo abono de un pago quincenal). Pasado ese plazo la
  mensualidad se desactiva y hay que editarla o registrarla de nuevo.
- La desactivación por vencimiento corre en **cada carga de página y en cada
  redibujado del Dashboard** (no solo al abrir Mensualidades), así que
  Dashboard, listado y bloqueo de entradas usan la misma regla.
- Pago quincenal (2 abonos): funciona tanto al registrar una mensualidad
  nueva como al renovarla. El saldo del segundo abono se calcula sobre lo
  **realmente cobrado** (después de descuento), no sobre el monto nominal
  sugerido.
- Si el pago se hace desde 1 día antes del vencimiento hasta 3 días
  después, el nuevo período arranca en la fecha de vencimiento anterior
  (no en la fecha de pago). Si se paga antes de esa ventana, se cobra el
  período ya registrado.
- **Pago por adelantado** (en cola): si faltan más de 1 día para el
  vencimiento se puede pagar el siguiente período; el actual sigue vigente y
  el nuevo arranca solo en su fecha de inicio.
- Horario Día/Noche: las de "Día" bloquean cualquier entrada normal de esa
  placa. Las de "Noche" solo bloquean dentro de la franja horaria
  configurada; fuera de esa franja se cobra como entrada ocasional y el
  monto queda registrado como "cargo fuera de horario" de esa mensualidad
  (queda en Pendientes).
- **Migración** de mensualidades existentes por CSV (con plantilla
  descargable): entran como pendientes de confirmar pago y un Administrador
  las confirma una a una con "Confirmar pago", sin pasar por Caja.
- "Reporte de mensualidades" con filtros (fechas, forma de pago) e impresión
  de recibo de cada pago (consecutivo propio `FM`).
- Estados que muestra la tabla: Activo, Renovación permitida, Vence hoy,
  Gracia 3 días, Vencido, Pendiente de pago, Pendiente de confirmar pago y
  Quincenal (abonado / pendiente).
- Dashboard ("Inicio"): tarjeta "Mensualidades por vencer / en mora" con código de
  colores — rojo (en mora o vence hoy), amarillo (1 a 3 días), verde (4 a 6
  días). La mora se muestra **sin límite de días**: las que superan los 3 días
  de gracia (que la app desactiva sola) siguen apareciendo como "Mora (N d)"
  hasta que se editen con nueva fecha, se renueven o se eliminen (o hasta que
  la purga de 12 meses las borre). No se listan las pendientes de confirmar
  pago ni las que ya tienen pagado el siguiente período, y un registro vencido
  no cuenta como mora si esa placa ya tiene otra mensualidad activa o por
  confirmar; con varios registros vencidos de una misma placa sale el más
  reciente. Ojo: pasada la gracia ya no aparece "Pagar mensualidad" (regla de
  los 3 días); se resuelve con Editar (Administrador) o Eliminar.
- Los diálogos de pago quincenal usan un modal HTML propio (no
  `window.prompt()`, que Electron no soporta de forma confiable).

### Pendientes
- Lista los cobros por salir del horario cubierto de una mensualidad nocturna,
  agrupados por mensualidad (o por placa): si la misma placa sale varias veces
  antes de pagar, se muestra una sola fila con el total.
- "Confirmar pago" abre el modal de pago (efectivo / electrónico / ambos, con
  descuento) y **requiere caja abierta**. Al confirmar, las salidas quedan
  como venta de parqueadero en Ventas y en la caja abierta en ese momento.
- Solo Administrador y Superadmin.

### Caja / Cierre de caja
- **Los pagos de mensualidades NO aparecen en Caja, Ventas ni en el
  resumen de cierre** (ni en pantalla, ni en PDF/impresión, ni en
  Reportes). Solo se ven en su propio "Reporte de mensualidades". Esta es
  la regla vigente confirmada en el código actual (`initCash()` solo usa
  `parkSales()`); versiones intermedias del proyecto la cambiaron más de
  una vez, así que si algún día se necesita volver a mostrarlas ahí, es un
  cambio deliberado, no un bug.
- Los pagos de mensualidades no exigen caja abierta ni se asocian a ninguna
  caja. La única excepción es el **cobro extra por salir del horario
  cubierto**: queda en Pendientes y, al confirmarlo, sí se registra como venta
  de parqueadero (requiere caja abierta).
- **Efectivo esperado = efectivo de las ventas de parqueadero + ingresos
  manuales − egresos.** La "Base del día" (caja inicial) se muestra pero **no
  se suma** al esperado. *Pendiente de confirmar:* que el efectivo físico se
  cuente sin la base; si se cuenta con la base, la diferencia saldría siempre
  igual a la base. La "Base del día" que se muestra ya incluye los movimientos
  de base de Transacciones (con el detalle "Inicial · + · −" debajo, en naranja).
- Las ventas con método de pago "Sin método" se cuentan como electrónicas en
  Caja, mientras que Reportes las muestra aparte.
- El resumen de cierre muestra: Base del día, Ventas (parqueadero), Pagos
  electrónicos, Ingresos manuales, Egresos, Efectivo esperado, Efectivo
  físico, Diferencia, Recibo inicial/final y recibos emitidos, y las tablas de
  detalle en este orden: **Ingresos manuales, Egresos, Ventas de parqueadero**.
- El aviso de estado de caja (abierta/cerrada) permanece siempre visible
  y se actualiza también si hay cambios desde otra pestaña (evento
  `storage`).

### Transacciones (`egresos.html`)
- Una sola tabla de **Movimientos** (ingresos manuales, egresos y movimientos de
  base juntos, del más reciente al más antiguo): los ingresos van en **verde**,
  los egresos en **rojo** y los movimientos de base en **naranja**, con su
  etiqueta de tipo y el valor con signo (+ / −).
- Arriba a la izquierda se muestra la **Base actual** de la caja abierta (en naranja).
- El botón **"+ Registrar nuevo movimiento"** abre un formulario con Tipo
  (Ingreso / Egreso / Agregar a la base / Quitar de la base, se debe elegir
  uno), Valor y Concepto (el concepto es opcional; si va vacío se muestra "—"). En el selector "Agregar a la base" va en verde y
  "Quitar de la base" en rojo; en el listado ambos se mantienen en naranja.
- **Movimientos de base** (`fp_base_in` = "Base +", `fp_base_out` = "Base −"):
  no son ingreso ni egreso. Solo modifican la "Base del día" de la caja
  (base inicial + Base + − Base −); no cambian el efectivo esperado ni Reportes.
  No se puede quitar más que la base actual ni dejar la base en negativo al
  editar/eliminar, y un movimiento de base de una caja ya cerrada no se puede
  editar ni eliminar (el cierre guarda `baseAdded`, `baseRemoved` y `baseFinal`). Editar usa el mismo
  formulario y permite cambiar también el tipo (el registro pasa a la otra
  lista conservando fecha, usuario y caja). Eliminar pide confirmación.
- Registrar uno exige caja abierta y lo asocia a esa caja; por eso entra en el
  resumen de cierre. Se actualiza en tiempo real si hay cambios desde otra
  pestaña/ventana.
- Por debajo se guardan igual que antes, en `fp_incomes` y `fp_expenses`
  (Caja, cierre y Reportes las leen por separado), más `fp_base_in` y
  `fp_base_out` para la base. El campo `observation` ya no
  se muestra ni se pide (los registros viejos lo conservan).

### Recibos (impresión térmica)
- Papel: **50 mm** (área útil 48 mm, con 1.5 mm de relleno interno a cada
  lado para que ninguna impresora recorte el último carácter).
- Letra (valores actuales del código): bloque principal 14px (los valores de
  Placa, Entrada, etc. van 1px más pequeños), datos del negocio 12.5px, nombre
  del negocio 14px en Entradas, horarios de atención 13px. Estos tamaños
  se definen en más de un lugar (`ParkApp.html` y `mvc/app-controller.js`), así
  que al cambiarlos hay que tocar todos.
- Los tres flujos de impresión (Entradas/Salidas en vivo, reimpresión
  desde Ventas, y Mensualidades) leen la misma configuración de
  Configuración → Edición completa de recibos (qué campos mostrar,
  etiquetas personalizadas, mensaje adicional).
- Fechas de Entrada/Salida en el recibo siempre se muestran sin segundos.

### Reportes
- Filtros por rango de fechas, KPIs (vehículos, ingresos, egresos,
  ganancia neta), gráfico de ingresos/egresos y de vehículos, desglose
  Efectivo vs Electrónico, tabla de cierres de caja (con detalle y descarga).
- **Ingresos = ventas de parqueadero + ingresos manuales.** El desglose
  Efectivo/Electrónico solo cuenta ventas de parqueadero, por lo que su suma
  no incluye los ingresos manuales.
- La gráfica depende del período: "Hoy" o un solo día → por horas, y arranca
  en la hora real de apertura de caja de ese día (lo ocurrido antes de esa hora
  no se grafica, aunque sí cuenta en los KPIs); Semana/Mes → por días;
  Año/Total → por meses. Al cambiar **Desde/Hasta a mano** el modo pasa a
  "personalizado": por horas si el rango es de un día, por días en cualquier
  otro caso.
- Exporta a Excel (`.xls`, en realidad HTML que Excel abre) y PDF/impresión sin
  depender de internet.
- Los cierres de caja guardados **antes** de que las mensualidades se
  sacaran de Caja conservan su total tal como quedó calculado en su
  momento (no se recalculan retroactivamente). Lo mismo aplica si después del
  cierre se edita la forma de pago de una venta: el cierre guardado no cambia,
  pero el desglose de Reportes sí.

### Ventas / Pagos
- Solo incluye ventas de parqueadero (entradas/salidas), nunca
  mensualidades ni cobros pendientes sin confirmar.
- Cada venta se puede editar (forma de pago) y el cambio se refleja en
  Caja, Reportes y el recibo — incluso si la venta ya fue archivada por
  antigüedad.
- Paginación de 10 ventas por página.

### Configuración
- **Tarifas** (Carro, Moto, Cicla), **Información del local**, **Edición
  completa de recibos** (entrada, salida/pago y mensualidad) y **Usuarios**
  (con las reglas de la sección "Roles y permisos").
- **Uso de almacenamiento:** diagnóstico de `localStorage` por clave, visible
  solo para el usuario `Felipe`.
- **Historial de ingresos** (quién entró y cuándo, máx. 300): solo Superadmin,
  que además puede limpiarlo.
- **Zona de peligro** (solo Superadmin): borra **todos** los datos del equipo
  (`localStorage.clear()`) tras dos confirmaciones (la segunda, escribir
  `BORRAR`); los usuarios vuelven a los valores de fábrica.

## Riesgos conocidos (no resueltos)

- **Credenciales por defecto en el código** (`Felipe/259148637`,
  `admin/admin`) — cambiar al instalar en un equipo nuevo.
- **Sin límite de intentos de login** pese a que documentación antigua lo
  mencionaba.
- **Hash de contraseña de una sola pasada** (SHA-256+salt sin
  iteraciones): suficiente para uso local, pero no es tan robusto como
  PBKDF2/scrypt si algún día los datos viajan fuera del equipo.
- **Cuota de `localStorage` (~100 MB, medida; solo en el `.exe`).** Medida con
  una prueba en Electron 31.7.7 (mismo `webPreferences` que la app): el límite es
  de ~99,98 MB (≈52,4 millones de caracteres UTF-16), no los ~10 MB habituales
  de Chromium. El diagnóstico de Configuración (`ESTIMATED_LIMIT_MB` = 100) y el
  aviso "almacenamiento casi lleno" (`fpCheckStorage()`, al 80 %, con
  `FP_STORAGE_LIMIT_CHARS` = 52.428.800) usan ahora ese mismo límite. Al llegar
  a él, `setItem` lanza `QuotaExceededError` y la app deja de guardar. El tope
  es **por instalación**: un navegador abierto con el `.bat` tiene el suyo
  (normalmente ~5–10 MB). Si se cambia de versión mayor de Electron conviene
  repetir la medición.
- **Purga automática de más de 12 meses**: entradas/salidas, ventas, ingresos,
  egresos, pagos de mensualidades, mensualidades vencidas y cierres de caja
  con más de 12 meses de antigüedad se borran de forma permanente e
  irreversible, **un día por cada vez que se abre la app** (parámetro
  `PURGE_MONTHS` en `mvc/app-controller.js`, antes en 6 meses). Se subió a 12
  asumiendo el límite de ~100 MB de arriba (ya medido); que 12 meses quepan
  depende del volumen del local, ver el diagnóstico de Configuración. Además:
  no purga `fp_monthly_extra_charges` (cobros pendientes) y puede borrar una
  salida de más de 12 meses cuyo cobro seguía pendiente de confirmar.
- **`resetOperationalDataV85()`** (en `ParkApp.html`) se ejecuta al cargar
  Entradas si falta su marca interna en `localStorage` (por ejemplo, al
  restaurar un backup viejo sin esa marca). Borra entradas, ventas,
  mensualidades y sus pagos, egresos, caja abierta, cierres y otras claves
  operativas; **no** borra `fp_incomes` ni `fp_monthly_extra_charges`, por lo
  que deja datos huérfanos. Es una limpieza de una sola vez que ya cumplió su
  función, pero sigue en el código.
- **Dos bases de datos posibles** (`.exe` vs. navegador con el `.bat`): ver la
  nota al inicio.
- **Reglas de permisos duplicadas** (menú vs. `auth()`): ver "Roles y permisos".

## Deuda técnica

- **`mvc/app-controller.js` es un archivo único de ~2.470 líneas** que mezcla
  routing, validaciones, renderizado y lógica de negocio de las pantallas.
  Separarlo por módulo reduciría el riesgo de romper una pantalla al tocar
  otra.
- **Código muerto:** `initProfile` (permite cambiar roles sin ninguna de las
  restricciones de `initConfigUsers`: no conectarla tal cual), `initServices`,
  `initClients`, `drawBarChart`, `mapMonthly` y `monthlyScheduleLabel`.
- **`prompt()` nativos de respaldo** en Ventas y Egresos (solo se usarían si
  faltaran los overlays de edición, que hoy existen). El changelog de V129 dice
  que se reemplazaron todos: quedan estos respaldos sin uso.
- **Marca mezclada:** conviven "Nexo.app", "Nexo.App" (menú lateral) y
  "FacaParking" (nombre del `.bat`, el negocio por defecto en recibos, el
  archivo `reporte_facaparking_*.xls` y algunos mensajes). Los avisos de "el
  navegador bloqueó la ventana…" no aplican en Electron.
- **`lang="en"`** en varias páginas cuyo contenido está en español.
- **Error de consola en Ventas** (`pagos.html`): `assets/material-dashboard.js`
  busca un `.navbar-form` que esa página no tiene. Es de la plantilla y no
  afecta el funcionamiento.
- Las pantallas cargan muchos scripts de la plantilla que no usan
  (`fullcalendar`, `jvectormap`, `dataTables`, …), lo que aumenta el tamaño del
  instalador y el tiempo de carga.

## Changelog condensado

### Serie 2.6.x (versionado nuevo)
- **2.6.7**: almacenamiento unificado (`fp_entries`), README único
  consolidado (este archivo).
- **2.6.8 – 2.6.11**: los zips entregados como 2.6.8 y 2.6.11 seguían con
  `package.json` en 2.6.7 (el número del nombre del zip iba por delante). El
  último trae el diálogo de confirmación al eliminar usuarios. Además, el
  código ya incluía —sin que el README lo documentara ni se conozca su versión
  de origen— la pantalla **Pendientes**, los **ingresos manuales** en
  Transacciones, los **roles** (Superadmin/Administrador/Empleado), el
  historial de ingresos, el diagnóstico de almacenamiento y la zona de peligro.
- **2.6.12**: usuarios — no se puede eliminar la propia cuenta ni la única
  cuenta de administración; al eliminar se limpia la lista de "usuarios
  recordados"; corregido el índice del formulario al eliminar un usuario
  mientras se edita otro. Los avisos de rechazo/validación (unos 40) se
  muestran en rojo en vez de verde.
- **2.6.13**: Reportes — cambiar Desde/Hasta a mano pasa a modo
  "personalizado" (la gráfica ya no queda pegada al botón anterior).
  Mensualidades — la desactivación por vencimiento corre en cada carga de
  página y en el Dashboard; no se puede dejar activa una mensualidad si otra
  vigente tiene la misma placa (comparación normalizada, también en el alta).
- **2.6.14**: versiones y documentación alineadas: `package.json`,
  `package-lock.json` y `APP_VERSION` en 2.6.14; README actualizado al estado
  real del código (roles, Pendientes, Transacciones, fórmula de Efectivo
  esperado, colores del Dashboard, ícono/instalador, riesgos y deuda técnica);
  comentarios desactualizados del código corregidos (purga, dashboard,
  `fpAlert`).
- **2.6.15**: cuota de `localStorage` medida en el `.exe` (~99,98 MB) y
  unificada: el aviso de almacenamiento lleno usa el límite real (antes saltaba
  a ~8 MB y mostraba un porcentaje 10 veces mayor al verdadero) y el
  diagnóstico de Configuración suma también el nombre de las claves.
- **2.6.16**: la opción de menú y el título del Dashboard pasan de "Vehículos" a
  "Inicio" (también el texto del menú estático de cada página). El Dashboard
  muestra la mora sin límite de días (antes solo hasta los 3 días de gracia).
  Transacciones pasa a una sola tabla con el botón "Registrar nuevo movimiento"
  (verde = ingreso, rojo = egreso); se elimina `initTransactionSection`.
- **2.6.17**: Transacciones — nuevos movimientos **"Agregar a la base" / "Quitar
  de la base"** en **naranja** (`fp_base_in` / `fp_base_out`). La "Base del día"
  de Caja y el resumen de cierre incluyen esos ajustes (con tabla "Movimientos
  de base del día"); la purga diaria también los cubre.

### Serie v37 → V131
Historial resumido de los parches aplicados, en orden. Cada punto refleja lo
que cambió respecto al estado anterior; el comportamiento **vigente** de cada
tema ya está descrito arriba, así que esta sección es solo referencia
histórica.

- **v37-v39**: base MVC inicial, login obligatorio, bloqueo de entrada
  normal para placas con mensualidad activa, reinicio único del
  consecutivo de recibos.
- **v41-v42**: renovación de mensualidades con lógica de calendario,
  recibo oficial de mensualidad, consecutivo unificado de recibos,
  Cierre de Caja con ventas + mensualidades juntas (regla luego cambiada).
- **v89**: recibos ajustados a papel térmico de 58 mm (medida luego
  corregida en V110/V111).
- **V84**: normalización del método de pago (Efectivo/Electrónico/Ambos).
- **V85-V87**: mensualidades se separan y luego se sacan por completo de
  Caja/Reportes (con un ajuste intermedio que las reintegró
  parcialmente, revertido de nuevo en V119/V120).
- **V94-V95**: descuentos en el cobro de entradas y de mensualidades;
  horario Día/Noche en mensualidades.
- **V96-V98**: edición de forma de pago en Ventas, edición/eliminación de
  egresos, tarjetas "Base del día" y "Pagos electrónicos" en Caja.
- **V99-V101**: rediseño completo de Reportes, corrección de parseo de
  fechas (`dd-mm-aaaa`) en Ventas/Dashboard/recibo de cierre, hora de
  entrada tomada en el instante real del clic en "Registrar".
- **V102**: pago quincenal habilitado también en el registro inicial de
  una mensualidad (no solo en la renovación); saldo del abono calculado
  sobre el monto realmente cobrado.
- **V103, V123**: limpieza de código muerto en Caja, Dashboard y Ventas.
- **V104-V106**: fixes de sincronización entre pestañas (Caja, Egresos,
  estado de caja visible) y edición de pagos en ventas archivadas.
- **V107**: se quitó el archivado manual de historial de la pantalla de
  Configuración (la purga automática sigue activa).
- **V108-V117, V126 (letra), V128, V130**: serie de ajustes de recibos —
  que el recibo impreso coincida con la vista previa, rediseño de la
  pantalla de edición de recibos, ancho de papel (58→56→50 mm),
  alineación y tamaños de letra, remoción de segundos en fecha/hora,
  relleno interno para evitar recorte de texto.
- **V118, V127**: plazo de gracia de 3 días aplicado a todos los flujos
  de pago de mensualidad; pago un día antes del vencimiento ya renueva
  correctamente el período.
- **V119/V120**: mensualidades retiradas definitivamente de Caja, Ventas
  y el resumen de cierre (estado vigente actual); egresos pasan a
  mostrarse antes que ventas en el resumen de cierre (luego el resumen
  sumó la sección de ingresos manuales, que va primero).
- **V121**: gráfica de Reportes por hora arranca desde la apertura real
  de caja, no desde medianoche.
- **V122, V124**: tarjeta de Dashboard con mensualidades próximas a
  vencer y colores por urgencia (los rangos vigentes están en la sección
  Mensualidades).
- **V125**: corregido que editar una mensualidad no perdiera su estado de
  pago; cargos fuera de horario ya confirmados dejan de sumar dos veces.
- **V126 (modal quincenal)**: reemplazo de `window.prompt()` (no soportado
  de forma confiable en Electron) por un modal HTML propio.
- **V129**: reemplazo de los `confirm()`/`prompt()` nativos por modales HTML
  propios para evitar que la ventana se quede "congelada" sin foco de
  teclado en Electron/Windows (quedan `prompt()` de respaldo sin uso, ver
  Deuda técnica); menor frecuencia de redibujado del dashboard y de las
  sugerencias de placa para mejorar rendimiento; aviso visible cuando
  `localStorage` se llena.
- **V131**: se unificó el almacenamiento de entradas/salidas a una sola
  clave (`fp_entries`), eliminando la duplicación con
  `facaparking_offline_entries_v4` en `ParkApp.html`, `reportes.html` y
  `mvc/app-controller.js`. Migración automática de una sola vez en
  `mvc/model.js` que fusiona y borra la clave vieja al abrir cualquier
  pantalla, liberando el espacio ya ocupado en instalaciones existentes.
