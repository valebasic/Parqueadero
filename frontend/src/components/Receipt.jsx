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

export function ReceiptTicket({ data, qr }) {
  const isExit = data.type === 'EXIT';
  const b = data.business ?? {};
  return (
    <div className="rc-ticket">
      <div className="rc-business">
        <span className="rc-business__name">{b.name}</span>
        {b.legalId && <span>NIT {b.legalId}</span>}
        {b.address && <span>{b.address}</span>}
        {b.phone && <span>Tel. {b.phone}</span>}
      </div>
      <hr className="rc-divider" />
      <div className="rc-main">
        <div className="rc-title">{isExit ? 'RECIBO DE PAGO' : 'TIQUETE DE ENTRADA'}</div>
        <Row label="Placa" value={data.plate} className="rc-plate" />
        <Row label="Servicio" value={data.vehicleLabel} />
        <Row label="Entrada" value={dateTime(data.entryAt)} />
        {isExit && <Row label="Salida" value={dateTime(data.exitAt)} />}
        {isExit && <Row label="Tiempo" value={formatDuration(data.minutes)} />}
        {isExit && data.discountAmount > 0 && (
          <>
            <Row label="Subtotal" value={formatCOP(data.calculatedAmount)} />
            <Row label="Descuento" value={`-${formatCOP(data.discountAmount)}`} />
          </>
        )}
        {isExit && <Row label="Total" value={formatCOP(data.chargedAmount)} className="rc-total" />}
        {isExit && <Row label="Pago" value={data.paymentLabel} />}
        {isExit && data.paymentMethod === 'MIXED' && (
          <>
            <Row label="Efectivo" value={formatCOP(data.cashAmount)} />
            <Row label="Electrónico" value={formatCOP(data.electronicAmount)} />
          </>
        )}
        <Row label="Recibo" value={data.receipt} className="rc-receiptno" />
        {data.operator && <Row label="Atendió" value={data.operator} />}
      </div>
      {qr && (
        <>
          <hr className="rc-divider" />
          <div className="rc-qr">
            <img src={qr} alt="" />
            <span>Consulte su recibo en el portal</span>
          </div>
        </>
      )}
      <hr className="rc-divider" />
      <div className="rc-footer">{isExit ? '¡Gracias por su visita!' : 'Conserve este tiquete para retirar su vehículo'}</div>
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
            title={data.type === 'EXIT' ? 'Recibo de pago' : 'Tiquete de entrada'}
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
