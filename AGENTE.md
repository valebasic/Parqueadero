# Definición del agente de Nexo.app

> **Estado:** implementado (ver carpeta `agente/`). Pendiente de probar dentro de la app Electron.

## 1. Punto de partida

| Pieza | Estado actual |
|---|---|
| `agente.js` | Modelo `gemini-3.5-flash-lite`, reglas de entrada/salida, prompt de sistema |
| `main.js` | Llama a Gemini; la API key vive en el proceso principal, nunca en el HTML |
| `mvc/assistant.js` | Chat flotante en `reportes*.html`; el código calcula agregados y la IA solo los explica |
| Roles | `Empleado`, `Administrador`, `Superadmin` (`isAdminLevelRole` en `mvc/app-controller.js`) |
| Datos | `localStorage` (`fp_entries`, `fp_incomes`, `fp_expenses`, `fp_monthly_payments`…) |

**Principio:** la IA interpreta y explica; el código calcula y autoriza. El rol sale de la sesión, nunca del texto de la pregunta.

## 2. Decisiones generales

| Tema | Decisión |
|---|---|
| Conexión | El agente funciona **solo con internet**. Sin conexión muestra un mensaje claro; no hay respuestas locales. |
| Carpetas | El agente tiene **sus propias carpetas** (ver sección 3). |
| Escritura | **Ningún rol modifica datos desde el chat.** Solo consulta y guía. |
| Privacidad | Nunca van a la IA: nombres, teléfonos, documentos, contraseñas ni la API key. Los nombres de empleados se resuelven en local. |
| Fuera de tema | Rechaza con amabilidad y dice que solo ayuda con el parqueadero. |

## 3. Estructura de carpetas propuesta

```
agente/
  index.js            # modelo, rol, filtro de contexto, prompt
  prompts/ (base, administrador, empleado)
  alertas/reglas.js   # umbrales y calculo de alertas (sin IA)
  cliente/asistente.js# widget de pantalla (reemplaza mvc/assistant.js)
  memoria/index.js    # preferencias, guardadas en userData/agente-memoria
```

Nota para el empaquetado: `package.json` lista los archivos de `build.files` uno por uno; habrá que añadir `agente/**/*` y quitar `agente.js`. La carpeta `memoria/` debe vivir en la carpeta de datos del usuario (`app.getPath('userData')`), no dentro del instalador, porque el instalador es de solo lectura.

## 4. Agente del Administrador (Administrador / Superadmin)

**Alcance:** consulta, análisis y recomendaciones. No modifica datos.

| Tema | Decisión |
|---|---|
| Formato | Texto corto con recomendaciones |
| Tono | Cercano y profesional, español, directo, hasta 120 palabras |
| Periodo de análisis | Hasta 12 meses (enviar agregados por mes para no inflar el contexto) |
| Memoria | Solo **preferencias** (formato, nivel de detalle, temas de interés) |
| Empleados | Puede ver actividad por empleado **con nombre**, resuelto en local |
| Recomienda sobre | Personal y turnos, tarifas, egresos y ahorro, mensualidades |

### Alertas al abrir la app
Cubren **lo que pasó el día anterior y lo que sigue pendiente**.

| Alerta | Regla |
|---|---|
| Permanencia inusual | Vehículo con más de **24 horas** sin salida |
| Caída de ingresos | Baja de más del **15 %** frente al periodo anterior |
| Caja: salidas sin pago | Vehículos que salieron sin cobro registrado |
| Caja: descuadre | Total del día distinto de la suma de cobros |
| Mensualidades por vencer | Aviso **3 días** antes del vencimiento |
| Egreso inusual | Mayor al **doble del promedio mensual** (hasta 12 meses) |

Las reglas se calculan en código; la IA solo redacta la alerta. Quedan fuera por ahora: cobros de valor atípico y registros duplicados.

### Preguntas típicas
- ¿Cómo estuvo el parqueadero esta semana?
- ¿Cuánto recaudamos este mes? ¿Cuál fue el día de mayor ocupación?
- ¿Qué empleado hizo más registros?
- ¿Hay inconsistencias en caja?
- ¿Qué tarifas conviene revisar?

Ejemplo de respuesta:
```
Semana 04–10 nov:
- 342 vehículos.
- Mayor ocupación: miércoles.
- Ingresos: +12 % vs. semana anterior.
- Pico de demanda: 2:00–5:00 p. m.
Recomendación: refuerza personal en ese horario.
```

## 5. Agente del Empleado

**Alcance:** consulta operativa y guía de procedimientos. No registra nada desde el chat.

| Tema | Decisión |
|---|---|
| Estilo | **Muy breve y paso a paso**, pensado para atender rápido en la caseta |
| Memoria | Ninguna |

### Puede consultar
- Vehículos que siguen dentro ahora.
- Estado por placa (hora de entrada, tiempo dentro).
- Valor a cobrar de un vehículo.
- **Tarifas.**

### Procedimientos que explica
- Cómo registrar una entrada y una salida.
- Cómo registrar una novedad. **Solo explica cómo hacerlo; no la registra el agente.**

### No puede ver
- Ingresos totales y ganancia.
- Egresos.
- Actividad de otros empleados.

Si pregunta algo de eso, el agente responde: **"Tu rol no tiene acceso a esos datos."**

### Fuera de alcance (decidido)
- Espacios disponibles: **no va**.
- Historial por placa: no se incluye.
- Ayuda para cobrar/dar cambio y casos especiales (ticket perdido, sin placa): no se incluyen por ahora.

## 6. Herramientas por rol

Cada herramienta valida el rol en `main.js` antes de ejecutarse.

| Herramienta | Admin | Empleado |
|---|:-:|:-:|
| `resumen_periodo(desde, hasta)` | ✅ | ❌ |
| `comparar_periodos(a, b)` | ✅ | ❌ |
| `ocupacion_por_franja(desde, hasta)` | ✅ | ❌ |
| `actividad_por_empleado(desde, hasta)` | ✅ | ❌ |
| `buscar_alertas()` | ✅ | ❌ |
| `vehiculos_activos()` | ✅ | ✅ |
| `consultar_placa(placa)` | ✅ | ✅ |
| `calcular_cobro(placa)` | ✅ | ✅ |
| `consultar_tarifas()` | ✅ | ✅ |

Todas son de **lectura**. No hay herramientas de escritura.

## 7. Cambios necesarios en el código actual

1. Mover `agente.js` a `agente/` y separar prompts por rol (`construirInstruccion(rol, contexto)`).
2. `preload.js` / `main.js`: enviar el rol con la pregunta y validarlo en el proceso principal; bloquear herramientas no permitidas.
3. `mvc/assistant.js`: ampliar de 120 días a 12 meses (agregados por mes) y añadir el widget del Empleado en las pantallas operativas (`index.html`, `caja.html`).
4. Calcular ocupación por franja horaria desde `entradaFecha` / `salidaFecha`.
5. Panel de alertas al abrir la app, con las reglas de la sección 4.
6. Guardar `memoria/preferencias.json` en `userData`.
7. Actualizar `build.files` en `package.json`.

## 8. Pendientes por decidir

1. **Mensualidades y el Empleado:** no quedó definido si el valor a cobrar de un cliente con mensualidad puede mostrar su nombre o pagos. Recomendación: mostrar solo "tiene mensualidad vigente / vencida", sin nombre.
2. **Modelo:** ¿se mantiene Gemini o se cambia de proveedor? Afecta cómo se implementan las herramientas.
3. **Cobros atípicos y duplicados:** quedaron fuera de las alertas; se pueden añadir después.
4. **Solicitud de informes por periodo** ("esta semana", "marzo") y si el agente indica su nivel de certeza en las recomendaciones.
