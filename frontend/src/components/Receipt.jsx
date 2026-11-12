import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import Modal from './Modal.jsx';
import { formatCOP, formatDate, formatDuration, formatTime12h } from '../lib/format.js';

// Recibo térmico de 50 mm (área útil 48 mm), impreso desde el navegador con @media print
// (styles/receipt.css). Mismo orden que el recibo de la v1.0: negocio · datos del servicio ·
// total · forma de pago · recibo; además un QR hacia el portal del cliente.

const dateTime = (v) => (v ? `${formatDate(v)} ${formatTime12h(v)}` : '—');

function Row({ label, value, className = '' }) {
  return (
    <div className={`rc-row ${className}`}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

// Etiquetas por defecto (Configuración → Recibos puede cambiarlas)
const DEFAULT_LABELS = {
  plate: 'Placa',
  vehicle: 'Servicio',
  entry: 'Entrada',
  exit: 'Salida',
  duration: 'Tiempo',
  total: 'Total',
  payment: 'Pago',
  receipt: 'Recibo',
  operator: 'Atendió',
};
// Campos que se pueden ocultar, por tipo de recibo (por defecto todos visibles)
const SECTION = { ENTRY: 'entry', EXIT: 'exit', MONTHLY: 'monthly' };

export function ReceiptTicket({ data, qr }) {
  const type = data.type;
  const isExit = type === 'EXIT';
  const isMonthly = type === 'MONTHLY';
  const b = data.business ?? {};
  const cfg = data.config ?? {};
  const L = { ...DEFAULT_LABELS, ...(cfg.labels ?? {}) };
  const show = (field) => cfg[SECTION[type]]?.show?.[field] !== false;
  const message =
    (type === 'ENTRY' && cfg.entryMessage) || (isMonthly && cfg.monthlyMessage) || cfg.message ||
    (isExit ? '¡Gracias por su visita!' : isMonthly ? 'Gracias por su pago' : 'Conserve este tiquete para retirar su vehículo');
  const title = isExit ? 'RECIBO DE PAGO' : isMonthly ? 'PAGO DE MENSUALIDAD' : 'TIQUETE DE ENTRADA';
  const paid = isExit || isMonthly;

  return (
    <div className="rc-ticket">
      {show('business') && (
        <>
          <div className="rc-business">
            <span className="rc-business__name">{b.name}</span>
            {b.legalId && <span>NIT {b.legalId}</span>}
            {b.address && <span>{b.address}</span>}
            {b.phone && <span>Tel. {b.phone}</span>}
          </div>
          <hr className="rc-divider" />
        </>
      )}
      <div className="rc-main">
        <div className="rc-title">{title}</div>
        <Row label={L.plate} value={data.plate} className="rc-plate" />
        {show('vehicle') && <Row label={L.vehicle} value={data.vehicleLabel} />}
        {isMonthly && <Row label="Titular" value={data.clientName} />}
        {isMonthly && <Row label="Período" value={`${formatDate(`${data.periodStart}T12:00:00`)} a ${formatDate(`${data.periodEnd}T12:00:00`)}`} />}
        {isMonthly && data.installmentNumber && <Row label="Abono" value={`${data.installmentNumber} de 2`} />}
        {isMonthly && data.isAdvance && <Row label="Tipo" value="Pago adelantado" />}
        {data.space && <Row label="Puesto" value={data.space.code} />}
        {!isMonthly && <Row label={L.entry} value={dateTime(data.entryAt)} />}
        {isExit && <Row label={L.exit} value={dateTime(data.exitAt)} />}
        {isExit && show('duration') && <Row label={L.duration} value={formatDuration(data.minutes)} />}
        {paid && data.discountAmount > 0 && (
          <>
            <Row label="Subtotal" value={formatCOP(isExit ? data.calculatedAmount : data.baseAmount)} />
            <Row label="Descuento" value={`-${formatCOP(data.discountAmount)}`} />
          </>
        )}
        {paid && <Row label={L.total} value={formatCOP(data.chargedAmount)} className="rc-total" />}
        {paid && <Row label={L.payment} value={data.paymentLabel} />}
        {paid && data.paymentMethod === 'MIXED' && (
          <>
            <Row label="Efectivo" value={formatCOP(data.cashAmount)} />
            <Row label="Electrónico" value={formatCOP(data.electronicAmount)} />
          </>
        )}
        {isMonthly && data.balance > 0 && <Row label="Saldo" value={formatCOP(data.balance)} />}
        {isMonthly && <Row label="Fecha" value={dateTime(data.paidAt)} />}
        <Row label={L.receipt} value={data.receipt} className="rc-receiptno" />
        {data.provisional && <div className="rc-provisional">Recibo provisional: el definitivo se asigna al sincronizar</div>}
        {data.operator && show('operator') && <Row label={L.operator} value={data.operator} />}
      </div>
      {qr && show('qr') && (
        <>
          <hr className="rc-divider" />
          <div className="rc-qr">
            <img src={qr} alt="" />
            <span>Consulte su recibo en el portal</span>
          </div>
        </>
      )}
      {b.hours && show('hours') && (
        <>
          <hr className="rc-divider" />
          <div className="rc-hours">
            <strong>Horario de atención</strong>
            <span>{b.hours}</span>
          </div>
        </>
      )}
      <hr className="rc-divider" />
      <div className="rc-footer">{message}</div>
    </div>
  );
}

const ReceiptContext = createContext(null);

// Muestra la vista previa del recibo con "Imprimir" (enfocado: Enter imprime) y "Cerrar".
export function ReceiptProvider({ children }) {
  const [data, setData] = useState(null);
  const [qr, setQr] = useState(null);
  const printRoot = useRef(null);

  if (!printRoot.current && typeof document !== 'undefined') {
    printRoot.current = document.getElementById('nx-print-root') ?? Object.assign(document.createElement('div'), { id: 'nx-print-root' });
    if (!printRoot.current.isConnected) document.body.appendChild(printRoot.current);
  }

  useEffect(() => {
    let cancelled = false;
    setQr(null);
    if (data?.qrUrl) {
      QRCode.toDataURL(data.qrUrl, { margin: 0, width: 220, errorCorrectionLevel: 'M' })
        .then((url) => !cancelled && setQr(url))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [data]);

  const showReceipt = useCallback((receipt) => setData(receipt), []);
  const close = useCallback(() => setData(null), []);
  const print = useCallback(() => window.print(), []);

  const value = useMemo(() => ({ showReceipt }), [showReceipt]);

  return (
    <ReceiptContext.Provider value={value}>
      {children}
      {data && (
        <>
          <Modal
            title={data.type === 'EXIT' ? 'Recibo de pago' : data.type === 'MONTHLY' ? 'Recibo de mensualidad' : 'Tiquete de entrada'}
            onClose={close}
            actions={
              <>
                <button type="button" className="nx-btn nx-btn--ghost" onClick={close}>
                  Cerrar
                </button>
                <button type="button" className="nx-btn nx-btn--accent" onClick={print} autoFocus>
                  Imprimir
                </button>
              </>
            }
          >
            <div className="rc-preview">
              <ReceiptTicket data={data} qr={qr} />
            </div>
          </Modal>
          {printRoot.current && createPortal(<ReceiptTicket data={data} qr={qr} />, printRoot.current)}
        </>
      )}
    </ReceiptContext.Provider>
  );
}

export function useReceipt() {
  const ctx = useContext(ReceiptContext);
  if (!ctx) throw new Error('useReceipt debe usarse dentro de <ReceiptProvider>');
  return ctx;
}
