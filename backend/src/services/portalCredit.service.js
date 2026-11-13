// Pago hecho por el cliente en el portal, listo para aplicarse al dar salida.
// Regla de negocio: después de pagar, el cliente tiene PORTAL_EXIT_WINDOW_MIN minutos (por defecto
// 10) para retirar el vehículo SIN cobro adicional. Pasado ese tiempo se cobra solo la diferencia.
const EXIT_WINDOW_MIN = () => Number.parseInt(process.env.PORTAL_EXIT_WINDOW_MIN, 10) || 10;

/**
 * Pago aprobado y sin aplicar de una entrada (o null).
 * @param {{query: Function}} client  pool o cliente de transacción
 */
async function findCredit(client, entryId) {
  const { rows } = await client.query(
    `SELECT id, amount, paid_at, provider,
            paid_at + make_interval(mins => $2) AS window_ends_at
       FROM portal_payments
      WHERE entry_id = $1 AND status = 'APPROVED' AND consumed_at IS NULL`,
    [entryId, EXIT_WINDOW_MIN()],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    amount: Number(r.amount),
    paidAt: r.paid_at,
    windowEndsAt: r.window_ends_at,
    provider: r.provider,
  };
}

/** ¿Sigue vigente la ventana de salida gratis en el instante `at`? */
function withinWindow(credit, at) {
  return Boolean(credit) && new Date(at).getTime() <= new Date(credit.windowEndsAt).getTime();
}

async function consumeCredit(client, creditId) {
  await client.query('UPDATE portal_payments SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [creditId]);
}

module.exports = { findCredit, withinWindow, consumeCredit, EXIT_WINDOW_MIN };
