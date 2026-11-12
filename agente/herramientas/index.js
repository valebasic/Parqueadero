/* Herramientas que la IA puede pedir, declaradas por rol (solo LECTURA).
 * Aqui solo se DECLARAN (nombre, descripcion, parametros). Se EJECUTAN en la pantalla
 * (agente/cliente/herramientas.js), donde estan los datos. main.js valida que la IA solo
 * pida herramientas de su rol. */
const S = (description) => ({ type: 'STRING', description });
const FECHA = 'Fecha en formato AAAA-MM-DD';

const comunes = [
  {
    name: 'vehiculos_dentro',
    description: 'Lista los vehiculos que estan dentro del parqueadero ahora mismo, con placa, servicio, hora de entrada, minutos dentro, saldo actual y si tienen mensualidad activa.',
    parameters: { type: 'OBJECT', properties: {
      servicio: S('Opcional. Filtra por servicio, por ejemplo "Carro" o "Moto".'),
      sin_mensualidad: { type: 'BOOLEAN', description: 'Opcional. true para excluir los vehiculos con mensualidad activa.' }
    } }
  },
  {
    name: 'consultar_placa',
    description: 'Informacion de una placa: si esta dentro, hora de entrada, saldo actual a la hora actual, o ultima salida y total cobrado; numero de visitas y mensualidad si tiene.',
    parameters: { type: 'OBJECT', properties: { placa: S('Placa del vehiculo, por ejemplo JJJ999.') }, required: ['placa'] }
  },
  {
    name: 'consultar_cliente',
    description: 'Busca clientes con mensualidad por nombre (o parte del nombre): placa, vigencia, si esta activa, valor y estado actual de su vehiculo.',
    parameters: { type: 'OBJECT', properties: { nombre: S('Nombre o parte del nombre del cliente.') }, required: ['nombre'] }
  },
  {
    name: 'consultar_tarifas',
    description: 'Tarifas vigentes por servicio: valor por hora, fraccion y tope de 12 horas.'
  }
];

const soloAdmin = [
  {
    name: 'resumen_periodo',
    description: 'Resumen financiero y de ocupacion entre dos fechas (maximo 400 dias): vehiculos, ventas de parqueadero, ingresos manuales, egresos, ganancia neta, ticket promedio, dias con actividad y pagos de mensualidades. Si el rango es de 31 dias o menos incluye el detalle por dia.',
    parameters: { type: 'OBJECT', properties: { desde: S(FECHA), hasta: S(FECHA) }, required: ['desde', 'hasta'] }
  },
  {
    name: 'comparar_periodos',
    description: 'Compara dos periodos (A contra B) y devuelve el resumen de cada uno y la variacion porcentual de vehiculos, ingresos, egresos y ganancia.',
    parameters: { type: 'OBJECT', properties: {
      desde_a: S(FECHA), hasta_a: S(FECHA), desde_b: S(FECHA), hasta_b: S(FECHA)
    }, required: ['desde_a', 'hasta_a', 'desde_b', 'hasta_b'] }
  },
  {
    name: 'resumen_por_mes',
    description: 'Serie mensual de los ultimos N meses (1 a 12): vehiculos, ingresos, egresos, ganancia y pagos de mensualidades de cada mes.',
    parameters: { type: 'OBJECT', properties: { meses: { type: 'INTEGER', description: 'Cantidad de meses, de 1 a 12. Por defecto 12.' } } }
  },
  {
    name: 'ocupacion_por_franja',
    description: 'Ocupacion entre dos fechas: las franjas horarias con mas entradas y las entradas por dia de la semana.',
    parameters: { type: 'OBJECT', properties: { desde: S(FECHA), hasta: S(FECHA) }, required: ['desde', 'hasta'] }
  },
  {
    name: 'actividad_empleados',
    description: 'Cantidad de registros de entrada por empleado entre dos fechas. Los empleados vienen como codigos (E1, E2...); usalos tal cual en la respuesta.',
    parameters: { type: 'OBJECT', properties: { desde: S(FECHA), hasta: S(FECHA) }, required: ['desde', 'hasta'] }
  },
  {
    name: 'consultar_alertas',
    description: 'Alertas actuales del sistema: vehiculos con mas de 24 horas dentro, caida de ingresos, salidas sin pago, descuadres de caja, mensualidades por vencer y egresos inusuales.'
  },
  {
    name: 'listar_mensualidades',
    description: 'Lista las mensualidades (cliente, placa, vigencia, valor) segun su estado.',
    parameters: { type: 'OBJECT', properties: {
      estado: { type: 'STRING', enum: ['activas', 'vencidas', 'por_vencer', 'todas'], description: 'Por defecto "activas". "por_vencer" = activas que vencen en 3 dias o menos.' }
    } }
  }
];

/* ---------- Acciones (solo PROPONEN; se ejecutan cuando la persona pulsa Confirmar) ---------- */
const PROPONE = ' No ejecuta nada: prepara la accion y la persona debe confirmarla con un boton.';
const lecturaAdmin = [
  {
    name: 'listar_novedades',
    description: 'Lista las novedades registradas por los empleados (fecha, placa, texto, quien la registro), las mas recientes primero.',
    parameters: { type: 'OBJECT', properties: { cantidad: { type: 'INTEGER', description: 'Cuantas mostrar (1 a 50). Por defecto 20.' } } }
  }
];
const accionesAdmin = [
  {
    name: 'proponer_movimiento',
    description: 'Propone registrar un ingreso o egreso manual en la caja abierta.' + PROPONE,
    parameters: { type: 'OBJECT', properties: {
      tipo: { type: 'STRING', enum: ['ingreso', 'egreso'], description: 'ingreso o egreso.' },
      valor: { type: 'INTEGER', description: 'Valor en pesos, entero y mayor que cero.' },
      concepto: S('Concepto del movimiento, por ejemplo "papeleria".')
    }, required: ['tipo', 'valor', 'concepto'] }
  },
  {
    name: 'proponer_informe',
    description: 'Propone generar y guardar un informe del periodo en PDF o Excel (resumen, detalle por dia, egresos e ingresos).' + PROPONE,
    parameters: { type: 'OBJECT', properties: {
      desde: S(FECHA), hasta: S(FECHA),
      formato: { type: 'STRING', enum: ['pdf', 'excel'], description: 'pdf o excel. Por defecto pdf.' }
    }, required: ['desde', 'hasta'] }
  },
  {
    name: 'proponer_cierre_caja',
    description: 'Propone cerrar la caja abierta actualmente, con el efectivo contado fisicamente. Si la persona no dijo cuanto efectivo conto, preguntaselo antes.' + PROPONE,
    parameters: { type: 'OBJECT', properties: {
      efectivo_fisico: { type: 'INTEGER', description: 'Efectivo contado en caja, en pesos.' },
      observacion: S('Opcional. Observacion del cierre.')
    }, required: ['efectivo_fisico'] }
  },
  {
    name: 'proponer_renovar_mensualidad',
    description: 'Propone renovar una mensualidad por un periodo mensual (pago completo). Solo se permite desde un dia antes del vencimiento. Si no dijeron el medio de pago, preguntalo antes.' + PROPONE,
    parameters: { type: 'OBJECT', properties: {
      cliente: S('Nombre del cliente (o parte).'),
      placa: S('Placa de la mensualidad (preferible si se conoce).'),
      medio_pago: { type: 'STRING', enum: ['efectivo', 'nequi'], description: 'efectivo o nequi.' }
    }, required: ['medio_pago'] }
  },
  {
    name: 'proponer_ajuste_tarifa',
    description: 'Propone cambiar una tarifa de un servicio.' + PROPONE,
    parameters: { type: 'OBJECT', properties: {
      servicio: S('Servicio, por ejemplo Carro o Moto.'),
      campo: { type: 'STRING', enum: ['hora', 'fraccion', 'tope_12_horas', 'mensualidad'], description: 'Que valor se cambia.' },
      valor: { type: 'INTEGER', description: 'Nuevo valor en pesos.' }
    }, required: ['servicio', 'campo', 'valor'] }
  }
];
const accionesEmpleado = [
  {
    name: 'proponer_novedad',
    description: 'Propone registrar una novedad (dano, incidente, observacion), opcionalmente asociada a una placa.' + PROPONE,
    parameters: { type: 'OBJECT', properties: {
      texto: S('Descripcion de la novedad.'),
      placa: S('Opcional. Placa relacionada.')
    }, required: ['texto'] }
  },
  {
    name: 'proponer_entrada',
    description: 'Propone registrar la entrada de un vehiculo por su placa (el servicio se detecta por el formato de la placa). No sirve para placas con mensualidad activa.' + PROPONE,
    parameters: { type: 'OBJECT', properties: { placa: S('Placa del vehiculo.') }, required: ['placa'] }
  }
];

const POR_ROL = {
  administrador: comunes.concat(soloAdmin, lecturaAdmin, accionesAdmin),
  empleado: comunes.concat(accionesEmpleado)
};

function herramientasDe(rol) { return POR_ROL[rol] || []; }
function nombresDe(rol) { return herramientasDe(rol).map(h => h.name); }

module.exports = { herramientasDe, nombresDe };
