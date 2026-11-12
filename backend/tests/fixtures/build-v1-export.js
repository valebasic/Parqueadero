// Genera tests/fixtures/v1-export.json: una exportación de la v1.0 con la forma REAL de sus datos
// (mvc/model.js, mvc/app-controller.js y ParkApp.html) y casos borde a propósito.
//   node tests/fixtures/build-v1-export.js
//
// Cuadre esperado (ver tests/db/migrate-v1.test.js):
//   Caja R1 (02/03/2026): ventas 28.500 (efectivo 17.200 · electrónico 11.300), ingreso 10.000,
//                         egreso 15.000, base + 20.000 → esperado 12.200, contado 12.200
//   Caja R2 (03/03/2026): ventas 22.600 (incluye 2 que se rechazan: recibo repetido y placa inválida),
//                         egreso 8.000, base − 30.000 → esperado 14.600, contado 14.500 (faltante 100)
//   Caja R3: quedó ABIERTA en la v1.0 → su venta y su egreso se rechazan
const fs = require('fs');
const path = require('path');
const { legacyV1Hash } = require('../../src/services/password.service');

// Sales fijas para que el archivo no cambie en cada ejecución
const hash = (pw, salt) => legacyV1Hash(pw, salt);

const users = [
  { username: 'Felipe', name: 'Felipe', document: '', email: '', phone: '', role: 'Superadmin', password: hash('259148637', 'a1'.repeat(16)) },
  { username: 'admin', name: 'admin', document: '', email: '', phone: '', role: 'Administrador', password: hash('admin', 'b2'.repeat(16)) },
  { username: 'carlos.p', name: 'Carlos Pérez', document: '1070111222', email: '', phone: '3101112233', role: 'Empleado', password: hash('Turno2025', 'c3'.repeat(16)) },
  // Instalación vieja: contraseña en texto plano
  { username: 'maria', name: 'María Gómez', document: '', email: 'maria@example.com', phone: '', role: 'Administrador', password: 'maria123' },
  { username: 'José Ñúñez', name: 'José Ñúñez', document: '', email: '', phone: '', role: 'Empleado', password: hash('Noche2025', 'd4'.repeat(16)) },
  { username: 'x', name: 'X', role: 'Empleado', password: hash('cualquiera', 'e5'.repeat(16)) },
];

const services = [
  { id: '5', code: 'CARRO', name: 'Carro', description: 'Servicio parqueadero carro', hour: 3300, fraction: 1800, full12h: 20000, monthly: 130000, active: true },
  // La moto subió en la v1.0: la v2.0 debe quedar con la tarifa nueva
  { id: '6', code: 'MOTO', name: 'Moto', description: 'Servicio parqueadero moto', hour: 2400, fraction: 1500, full12h: 14000, monthly: 80000, active: true },
  { id: '7', code: 'CICLA', name: 'Cicla', description: 'Servicio parqueadero cicla', hour: 0, fraction: 0, full12h: 10000, monthly: 0, active: false },
];

const config = {
  parkingName: 'FACAPARKING',
  razon_social: 'FACAPARKING',
  nit: '35529806-9',
  telefonos: '3137139757',
  phone: '3137139757',
  direccion1: 'CARRERA 3 # 7 -132',
  address: 'CARRERA 3 # 7 -132',
  limiteVehiculos: '100',
  capacity: 100,
  receiptPrefix: 'FA',
  nextReceiptNumber: 1042,
  receiptPrefixMonthly: 'FM',
  nextReceiptNumberMonthly: 57,
  currency: 'COP',
  autoPrint: false,
  customMessage: 'Gracias por su visita',
  additionalInfo: 'No nos hacemos responsables por objetos dejados en el vehículo',
  entryHoursText: 'Lunes a Miércoles:\n06:30 a 21:30\nJueves a Sábado:\n06:30 a 23:00\nDomingos y Festivos:\n06:30 a 19:00',
  entryShowBusiness: true,
  entryShowHours: true,
  exitShowBusiness: true,
  exitShowTime: true,
  monthlyShowBusiness: true,
  exitLabelPlate: 'Placa',
  exitLabelEntry: 'Entrada',
  exitLabelExit: 'Salida',
  exitLabelTime: 'Tiempo',
  exitLabelTotal: 'Total',
  exitLabelPaymentMethod: 'Forma de pago',
  monthlyLabelReceipt: 'Consecutivo',
};

// Entrada de ParkApp (fechas 'dd-mm-aaaa HH:MM:SS', hora local)
function entry(id, n, placa, idTarifa, entrada, salida, extra = {}) {
  const e = {
    id,
    idParqueadero: '1',
    idCliente: '2',
    idTarifa,
    idUsuario: '3',
    placa,
    entradaFecha: entrada,
    entradaHora: entrada.slice(11),
    reciboPrefijo: 'FA',
    reciboNumero: n,
    salidaFecha: '',
    salidaHora: '',
    codigoBarras: 'NA',
    local: true,
  };
  if (salida) {
    Object.assign(e, {
      salidaFecha: salida,
      salidaHora: salida.slice(11),
      subtotal: extra.total,
      discountType: 'none',
      discountValue: 0,
      discountAmount: 0,
      discountReason: '',
      normalFare: extra.total,
      tariffType: 'normal',
      full12h: idTarifa === '7' ? 10000 : 20000,
      paymentMethod: 'cash',
      idTipoPago: 'cash',
      cashAmount: extra.total,
      nequiAmount: 0,
    });
  }
  return Object.assign(e, extra);
}

const entries = [
  // Caja R1 · 02/03/2026
  entry(1772452200000, 1001, 'ABC123', '5', '02-03-2026 07:10:00', '02-03-2026 09:15:00', { total: 7200, registerId: 'R1772450000000' }),
  entry(1772452800000, 1002, 'XYZ12D', '6', '02-03-2026 07:20:00', '02-03-2026 08:40:00', {
    total: 4400, paymentMethod: 'nequi', idTipoPago: 'nequi', cashAmount: 0, nequiAmount: 4400, registerId: 'R1772450000000',
  }),
  entry(1772455800000, 1003, 'DEF456', '5', '02-03-2026 08:10:00', '02-03-2026 10:05:00', {
    total: 6600, paymentMethod: 'both', idTipoPago: 'both', cashAmount: 3000, nequiAmount: 3600, registerId: 'R1772450000000',
  }),
  // Descuento SIN motivo (la v1.0 lo permitía): se importa con un motivo genérico
  entry(1772463000000, 1004, 'GHI789', '5', '02-03-2026 10:10:00', '02-03-2026 13:30:00', {
    total: 7000, subtotal: 9000, discountType: 'charged', discountValue: 2000, discountAmount: 2000, discountReason: '',
    cashAmount: 7000, registerId: 'R1772450000000',
  }),
  // "Sin método" (venta vieja sin forma de pago): la caja v1 no la contaba como efectivo
  entry(1772470800000, 1005, 'JKL321', '5', '02-03-2026 12:20:00', '02-03-2026 13:25:00', {
    total: 3300, paymentMethod: undefined, idTipoPago: undefined, cashAmount: undefined, nequiAmount: undefined, registerId: 'R1772450000000',
  }),

  // Caja R2 · 03/03/2026
  entry(1772539200000, 1006, 'MNO654', '5', '03-03-2026 07:00:00', '03-03-2026 09:50:00', { total: 5100, registerId: 'R1772536400000' }),
  entry(1772541000000, 1007, 'CICLA', '7', '03-03-2026 07:30:00', '03-03-2026 18:10:00', { total: 10000, registerId: 'R1772536400000' }),
  // Recibo repetido (FA1006): se rechaza
  entry(1772548200000, 1006, 'PQR987', '5', '03-03-2026 09:30:00', '03-03-2026 10:20:00', { total: 2000, registerId: 'R1772536400000' }),
  // Placa inválida: se rechaza
  entry(1772550000000, 1008, 'AB-1', '5', '03-03-2026 10:00:00', '03-03-2026 11:00:00', { total: 2500, registerId: 'R1772536400000' }),
  // Mensualidad nocturna fuera de franja: salida sin cobrar, queda en Pendientes
  entry(1772553600000, 1009, 'NOC123', '5', '03-03-2026 11:00:00', '03-03-2026 12:40:00', {
    total: 4000, paymentMethod: undefined, idTipoPago: undefined, cashAmount: undefined, nequiAmount: undefined,
    pendingMonthlyConfirmation: true, linkedMonthlyId: 'M1772000000002',
  }),
  // Pendiente manual ya confirmado (se cobró en la caja R2)
  entry(1772557200000, 1010, 'PEN111', '5', '03-03-2026 12:00:00', '03-03-2026 13:10:00', {
    total: 3000, registerId: 'R1772536400000', pendingMonthlyConfirmation: false,
  }),
  // Vehículo que sigue adentro al exportar
  entry(1772586000000, 1011, 'OPN777', '5', '03-03-2026 20:00:00', null, {}),
  // Venta de la caja R3, que quedó abierta en la v1.0: se rechaza
  entry(1772625600000, 1012, 'STU246', '5', '04-03-2026 07:00:00', '04-03-2026 08:30:00', { total: 6000, registerId: 'R1772622000000' }),
];

// Archivo de entradas viejas: una repetida (también está en fp_entries) y una de una caja que ya no existe
const archive = [
  entries[0],
  entry(1769958000000, 900, 'AAA111', '5', '01-02-2026 10:00:00', '01-02-2026 11:00:00', { total: 3300, registerId: 'R1769950000000' }),
];

const extraCharges = [
  { id: 'MX1772560000000', monthlyId: 'M1772000000002', plate: 'NOC123', entryId: 1772553600000, amount: 4000, dateTime: '2026-03-03T17:40:00.000Z', receiptPrefix: 'FA', receiptNumber: 1009, confirmed: false },
  { id: 'MX1772561000000', monthlyId: null, plate: 'PEN111', entryId: 1772557200000, amount: 3000, dateTime: '2026-03-03T18:10:00.000Z', receiptPrefix: 'FA', receiptNumber: 1010, confirmed: true, manual: true, confirmedAt: '2026-03-03T19:00:00.000Z' },
  // Cargo cuya entrada no está en el archivo: se rechaza
  { id: 'MX1772562000000', monthlyId: null, plate: 'ZZZ999', entryId: 999, amount: 2500, dateTime: '2026-03-03T19:30:00.000Z', receiptPrefix: 'FA', receiptNumber: 990, confirmed: false, manual: true },
];

const monthly = [
  {
    id: 'M1772000000001', document: '3001234567', name: 'Ana Torres', plate: 'MEN001', vehicle: 'Carro', start: '2026-03-01', end: '2026-03-31',
    value: 130000, schedule: 'day', nightEntryLimit: '', nightExitLimit: '', active: true, paymentStatus: 'paid', biweekly: false,
    nextPeriod: { start: '2026-04-01', end: '2026-04-30', paidAt: '2026-03-25T15:00:00.000Z', receiptPrefix: 'FM', receiptNumber: 54 },
    createdAt: '2026-01-01T15:00:00.000Z', updatedAt: '2026-03-25T15:00:00.000Z',
  },
  {
    id: 'M1772000000002', document: '3009876543 / 3155550000', name: 'Luis Rojas', plate: 'NOC123', vehicle: 'Carro', start: '2026-03-01', end: '2026-03-31',
    value: 90000, schedule: 'night', nightEntryLimit: '19:00', nightExitLimit: '07:00', active: true, paymentStatus: 'paid', biweekly: false,
    createdAt: '2026-02-01T15:00:00.000Z', updatedAt: '2026-03-01T15:00:00.000Z',
  },
  // Importada por CSV en la v1.0: falta que un administrador confirme el pago
  {
    id: 'M1772000000003_0', document: '3112223344', name: 'Marta Ruiz', plate: 'MIG001', vehicle: 'Moto', start: '2026-02-15', end: '2026-03-14',
    value: 80000, schedule: 'day', nightEntryLimit: '', nightExitLimit: '', active: false, pendingConfirmation: true, biweekly: false,
    origen: 'migracion', createdAt: '2026-02-15T15:00:00.000Z', updatedAt: '2026-02-15T15:00:00.000Z',
  },
  // Quincenal con el primer abono pagado
  {
    id: 'M1772000000004', document: '3120001122', name: 'Jorge Díaz', plate: 'QUI001', vehicle: 'Carro', start: '2026-02-15', end: '2026-03-14',
    value: 130000, schedule: 'day', nightEntryLimit: '', nightExitLimit: '', active: true, paymentStatus: 'pending', biweekly: true,
    installment: { targetStart: '2026-03-15', targetEnd: '2026-04-14', total: 130000, paid: 65000, dueDate: '2026-03-30' },
    createdAt: '2026-02-15T15:00:00.000Z', updatedAt: '2026-03-15T15:00:00.000Z',
  },
  // Duplicada: otra vigente de la misma placa MEN001 (más vieja): se rechaza
  {
    id: 'M1772000000005', document: '3001234567', name: 'Ana Torres', plate: 'MEN001', vehicle: 'Carro', start: '2026-02-21', end: '2026-03-20',
    value: 130000, schedule: 'day', active: true, paymentStatus: 'paid', biweekly: false, createdAt: '2026-02-21T15:00:00.000Z',
  },
  // Fecha de vencimiento inválida: se rechaza
  { id: 'M1772000000006', document: '', name: 'Sin Fecha', plate: 'BAD001', vehicle: 'Carro', start: '2026-03-01', end: '31/02/2026', value: 130000, schedule: 'day', active: true },
];

const payments = [
  {
    id: 'MP1772000000001', monthlyId: 'M1772000000001', plate: 'MEN001', client: 'Ana Torres', document: '3001234567', vehicle: 'Carro',
    value: 130000, originalValue: 130000, discountAmount: 0, paymentMethod: 'cash', cashAmount: 130000, nequiAmount: 0,
    dateTime: '2026-03-01T14:00:00.000Z', periodStart: '2026-03-01', periodEnd: '2026-03-31', receiptPrefix: 'FM', receiptNumber: 50,
    registerId: null, user: 'Felipe', isInstallment: false, advance: false,
  },
  {
    id: 'MP1772000000002', monthlyId: 'M1772000000002', plate: 'NOC123', client: 'Luis Rojas', document: '3009876543', vehicle: 'Carro',
    value: 90000, originalValue: 90000, discountAmount: 0, paymentMethod: 'nequi', cashAmount: 0, nequiAmount: 90000,
    dateTime: '2026-03-01T15:00:00.000Z', periodStart: '2026-03-01', periodEnd: '2026-03-31', receiptPrefix: 'FM', receiptNumber: 51,
    registerId: null, user: 'María Gómez', isInstallment: false, advance: false,
  },
  {
    id: 'MP1772000000003', monthlyId: 'M1772000000004', plate: 'QUI001', client: 'Jorge Díaz', document: '3120001122', vehicle: 'Carro',
    value: 65000, originalValue: 65000, discountAmount: 0, paymentMethod: 'cash', cashAmount: 65000, nequiAmount: 0,
    dateTime: '2026-03-15T14:00:00.000Z', periodStart: '2026-03-15', periodEnd: '2026-04-14', receiptPrefix: 'FM', receiptNumber: 52,
    registerId: null, user: 'Felipe', isInstallment: true, advance: false,
  },
  // Pago de una mensualidad que se eliminó en la v1.0: se reconstruye la mensualidad (eliminada)
  {
    id: 'MP1772000000004', monthlyId: 'M1760000000999', plate: 'OLD999', client: 'Pedro Peña', document: '3000000000', vehicle: 'Carro',
    value: 120000, originalValue: 130000, discountAmount: 10000, paymentMethod: 'both', cashAmount: 60000, nequiAmount: 60000,
    dateTime: '2026-02-01T14:00:00.000Z', periodStart: '2026-02-01', periodEnd: '2026-02-28', receiptPrefix: 'FM', receiptNumber: 53,
    registerId: null, user: 'Felipe', isInstallment: false, advance: false,
  },
  // Recibo repetido (FM50): se rechaza
  {
    id: 'MP1772000000005', monthlyId: 'M1772000000001', plate: 'MEN001', client: 'Ana Torres', vehicle: 'Carro', value: 130000,
    paymentMethod: 'cash', cashAmount: 130000, nequiAmount: 0, dateTime: '2026-03-02T14:00:00.000Z', periodStart: '2026-03-01',
    periodEnd: '2026-03-31', receiptPrefix: 'FM', receiptNumber: 50, user: 'Felipe', isInstallment: false, advance: false,
  },
  // Pago adelantado del período siguiente
  {
    id: 'MP1772000000006', monthlyId: 'M1772000000001', plate: 'MEN001', client: 'Ana Torres', vehicle: 'Carro', value: 130000,
    originalValue: 130000, discountAmount: 0, paymentMethod: 'nequi', cashAmount: 0, nequiAmount: 130000,
    dateTime: '2026-03-25T15:00:00.000Z', periodStart: '2026-04-01', periodEnd: '2026-04-30', receiptPrefix: 'FM', receiptNumber: 54,
    user: 'Felipe', isInstallment: false, advance: true,
  },
];

// Movimientos de Transacciones: { id, concept, amount, observation, dateTime, user, registerId }
const mov = (id, concept, amount, dateTime, user, registerId) => ({ id, concept, amount, observation: '', dateTime, user, registerId });
const incomes = [
  mov('I1772460000000', 'Lavado', 10000, '2026-03-02T15:00:00.000Z', 'Carlos Pérez', 'R1772450000000'),
  mov('I1772460000001', 'Valor en cero', 0, '2026-03-02T15:05:00.000Z', 'Carlos Pérez', 'R1772450000000'),
];
const expenses = [
  mov('E1772461000000', 'Bolsas de basura', 15000, '2026-03-02T16:00:00.000Z', 'Carlos Pérez', 'R1772450000000'),
  mov('E1772547000000', 'Tinto', 8000, '2026-03-03T15:00:00.000Z', 'José Ñúñez', 'R1772536400000'),
  mov('E1772630000000', 'Escoba', 5000, '2026-03-04T13:00:00.000Z', 'Carlos Pérez', 'R1772622000000'),
];
const baseIn = [mov('BI1772452000000', 'Sencillo', 20000, '2026-03-02T12:00:00.000Z', 'Felipe', 'R1772450000000')];
const baseOut = [mov('BO1772580000000', 'Retiro a Felipe', 30000, '2026-03-03T23:00:00.000Z', 'José Ñúñez', 'R1772536400000')];

const closings = [
  {
    id: 'C1772502000000', registerId: 'R1772450000000', openedAt: '2026-03-02T11:30:00.000Z', closedAt: '2026-03-03T02:40:00.000Z',
    openedBy: 'Carlos Pérez', closedBy: 'Carlos Pérez', initialCash: 50000, baseAdded: 20000, baseRemoved: 0, baseFinal: 70000,
    totalSales: 28500, totalPark: 28500, totalElectronic: 11300, totalEgresos: 15000, totalIngresosManuales: 10000,
    expectedCash: 12200, physicalCash: 12200, difference: 0, status: 'balanced', receiptStart: 1001, receiptEnd: 1005, receiptCount: 5, observation: '',
  },
  {
    id: 'C1772588000000', registerId: 'R1772536400000', openedAt: '2026-03-03T11:13:20.000Z', closedAt: '2026-03-04T01:40:00.000Z',
    openedBy: 'José Ñúñez', closedBy: 'José Ñúñez', initialCash: 50000, baseAdded: 0, baseRemoved: 30000, baseFinal: 20000,
    totalSales: 22600, totalPark: 22600, totalElectronic: 0, totalEgresos: 8000, totalIngresosManuales: 0,
    expectedCash: 14600, physicalCash: 14500, difference: -100, status: 'deficit', receiptStart: 1006, receiptEnd: 1010, receiptCount: 5,
    observation: 'Faltaron 100 pesos',
  },
];
// Copia vieja del primer cierre en la clave anterior (fp_closures): no se duplica
const legacyClosures = [closings[0]];

const openRegister = { id: 'R1772622000000', openedAt: '2026-03-04T11:00:00.000Z', openedBy: 'Carlos Pérez', initialCash: 50000, observation: '' };

const keys = {
  fp_users: users,
  fp_user: users[0],
  fp_services: services,
  fp_config: config,
  fp_entries: entries,
  fp_entries_archive: archive,
  fp_monthly: monthly,
  fp_monthly_payments: payments,
  fp_monthly_extra_charges: extraCharges,
  fp_incomes: incomes,
  fp_expenses: expenses,
  fp_base_in: baseIn,
  fp_base_out: baseOut,
  fp_cash_closings: closings,
  fp_closures: legacyClosures,
  fp_cash_register: openRegister,
  fp_sales: [],
  fp_login_history: [{ username: 'Felipe', at: '2026-03-04T10:59:00.000Z' }],
  facaparking_offline_receipt_v4: 1041,
  facaparking_offline_receipt_monthly_v1: 56,
  fp_sidebar_mini: false,
};

// Así lo guarda el botón de la v1.0: cada valor es el TEXTO de localStorage
const exported = {
  format: 'nexo-v1-export',
  formatVersion: 1,
  appVersion: '2.6.52',
  exportedAt: '2026-03-04T13:30:00.000Z',
  exportedBy: 'Felipe',
  keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, JSON.stringify(v)])),
};

fs.writeFileSync(path.join(__dirname, 'v1-export.json'), `${JSON.stringify(exported, null, 2)}\n`);
console.log('tests/fixtures/v1-export.json generado');
