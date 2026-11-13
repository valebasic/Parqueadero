// Configuración (RF23-RF24): tarifas por sede con vigencia e historial, datos del local y
// edición de recibos. AG en todas las sedes; AS en las suyas.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { VEHICLE_LABELS } = require('../lib/plates');
const { MAX_MONEY } = require('../lib/payments');
const { recordAudit } = require('./audit.service');

const VEHICLE_TYPES = ['CAR', 'MOTORCYCLE', 'BICYCLE'];

function toRateDto(r) {
  return {
    id: r.id,
    vehicleType: r.vehicle_type,
    vehicleLabel: VEHICLE_LABELS[r.vehicle_type],
    fractionAmount: r.fraction_amount,
    hourAmount: r.hour_amount,
    full12hAmount: r.full_12h_amount,
    monthlyAmount: r.monthly_amount,
    pricingMode: r.pricing_mode,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    state: r.state,
    createdBy: r.created_by_name ?? null,
    createdAt: r.created_at,
  };
}

// Tarifas de la sede: vigentes ahora, programadas (futuras) e historial
async function listRates(req, rawSiteId) {
  const siteId = Number.parseInt(rawSiteId, 10);
  await assertSiteAccess(req, siteId);
  const { rows } = await query(
    `SELECT r.*, u.full_name AS created_by_name,
            CASE WHEN r.valid_from > now() THEN 'SCHEDULED'
                 WHEN r.valid_to IS NOT NULL AND r.valid_to <= now() THEN 'HISTORY'
                 ELSE 'CURRENT' END AS state
       FROM rates r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.site_id = $1
      ORDER BY r.vehicle_type, r.valid_from DESC`,
    [siteId],
  );
  const all = rows.map(toRateDto);
  return {
    current: VEHICLE_TYPES.map((t) => all.find((r) => r.vehicleType === t && r.state === 'CURRENT') ?? null).filter(Boolean),
    scheduled: all.filter((r) => r.state === 'SCHEDULED'),
    history: all.filter((r) => r.state === 'HISTORY'),
  };
}

/**
 * Nueva tarifa con vigencia: { vehicleType, fractionAmount, hourAmount, full12hAmount, monthlyAmount,
 * pricingMode, validFrom? (ISO; por defecto ahora) }. La tarifa abierta del mismo tipo se cierra en
 * validFrom; el historial se conserva (cada entrada guarda con qué tarifa se cobró).
 */
async function createRate(req, rawSiteId, body) {
  const siteId = Number.parseInt(rawSiteId, 10);
  await assertSiteAccess(req, siteId);
  const b = body ?? {};
  if (!VEHICLE_TYPES.includes(b.vehicleType)) throw new HttpError(400, 'Tipo de vehículo inválido', { code: 'VALIDATION_ERROR' });
  const amounts = {};
  for (const key of ['fractionAmount', 'hourAmount', 'full12hAmount', 'monthlyAmount']) {
    const v = b[key] ?? 0;
    if (!Number.isInteger(v) || v < 0 || v > MAX_MONEY) {
      throw new HttpError(400, 'Los valores de la tarifa deben ser enteros de $ 0 en adelante', { code: 'VALIDATION_ERROR' });
    }
    amounts[key] = v;
  }
  const pricingMode = b.pricingMode ?? 'normal';
  if (!['normal', 'block12h'].includes(pricingMode)) throw new HttpError(400, 'Modo de cobro inválido', { code: 'VALIDATION_ERROR' });
  if (pricingMode === 'block12h' && amounts.full12hAmount <= 0) {
    throw new HttpError(400, 'El cobro por bloques de 12 h necesita la tarifa plena de 12 h', { code: 'VALIDATION_ERROR' });
  }
  if (pricingMode === 'normal' && amounts.hourAmount <= 0) {
    throw new HttpError(400, 'El cobro normal necesita el valor de la hora', { code: 'VALIDATION_ERROR' });
  }
  const validFrom = b.validFrom ? new Date(b.validFrom) : null;
  if (validFrom && Number.isNaN(validFrom.getTime())) {
    throw new HttpError(400, 'Fecha de vigencia inválida', { code: 'VALIDATION_ERROR' });
  }

  const id = await withTransaction(async (client) => {
    const { rows: nowRows } = await client.query('SELECT now() AS now');
    const from = validFrom ?? nowRows[0].now;
    if (from.getTime() < nowRows[0].now.getTime() - 60000) {
      throw new HttpError(400, 'La vigencia no puede empezar en el pasado (el historial no se reescribe)', { code: 'VALIDATION_ERROR' });
    }
    const { rows: open } = await client.query(
      `SELECT * FROM rates WHERE site_id = $1 AND vehicle_type = $2 ORDER BY valid_from DESC FOR UPDATE`,
      [siteId, b.vehicleType],
    );
    const latest = open[0];
    if (latest && new Date(latest.valid_from).getTime() >= from.getTime()) {
      throw new HttpError(409, 'Ya hay una tarifa programada desde esa fecha o después. Elija una vigencia posterior.', {
        code: 'RATE_OVERLAP',
      });
    }
    if (latest && latest.valid_to === null) {
      await client.query('UPDATE rates SET valid_to = $2 WHERE id = $1', [latest.id, from]);
    }
    const { rows } = await client.query(
      `INSERT INTO rates (site_id, vehicle_type, fraction_amount, hour_amount, full_12h_amount, monthly_amount,
                          pricing_mode, valid_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [siteId, b.vehicleType, amounts.fractionAmount, amounts.hourAmount, amounts.full12hAmount, amounts.monthlyAmount,
        pricingMode, from, req.user.id],
    );
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId,
        action: 'RATE_CHANGED',
        entityType: 'rate',
        entityId: rows[0].id,
        details: {
          vehicleType: b.vehicleType,
          validFrom: from,
          before: latest
            ? { fraction: latest.fraction_amount, hour: latest.hour_amount, full12h: latest.full_12h_amount, monthly: latest.monthly_amount, mode: latest.pricing_mode }
            : null,
          after: { ...amounts, pricingMode },
        },
      },
      client,
    );
    return rows[0].id;
  });
  const { rows } = await query("SELECT r.*, 'NEW' AS state FROM rates r WHERE id = $1", [id]);
  return toRateDto(rows[0]);
}

// Tarifa programada que todavía no empieza: se puede cancelar (la anterior vuelve a quedar abierta)
async function cancelScheduledRate(req, rawSiteId, rawRateId) {
  const siteId = Number.parseInt(rawSiteId, 10);
  await assertSiteAccess(req, siteId);
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM rates WHERE id = $1 AND site_id = $2 FOR UPDATE', [rawRateId, siteId]);
    const rate = rows[0];
    if (!rate) throw new HttpError(404, 'Tarifa no encontrada', { code: 'NOT_FOUND' });
    const { rows: started } = await client.query('SELECT $1::timestamptz <= now() AS started', [rate.valid_from]);
    if (started[0].started || rate.valid_to !== null) {
      throw new HttpError(409, 'Solo se puede cancelar una tarifa programada que aún no empieza', { code: 'RATE_STARTED' });
    }
    await client.query('DELETE FROM rates WHERE id = $1', [rate.id]);
    await client.query(
      'UPDATE rates SET valid_to = NULL WHERE site_id = $1 AND vehicle_type = $2 AND valid_to = $3',
      [siteId, rate.vehicle_type, rate.valid_from],
    );
    await recordAudit(
      { req, userId: req.user.id, siteId, action: 'RATE_SCHEDULE_CANCELLED', entityType: 'rate', entityId: rate.id, details: { vehicleType: rate.vehicle_type } },
      client,
    );
  });
}

// ---------------------------------------------------------------------------
// Datos del local y recibos
// ---------------------------------------------------------------------------

const RECEIPT_FIELDS = ['business', 'zone', 'vehicle', 'duration', 'operator', 'qr', 'hours', 'message'];
const RECEIPT_LABELS = ['plate', 'vehicle', 'entry', 'exit', 'duration', 'total', 'payment', 'receipt', 'operator'];

// Normaliza la configuración de recibos: { entry|exit|monthly: { show: {campo: bool} }, labels, message, entryMessage }
function sanitizeReceiptConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {};
  const out = { labels: {}, entry: { show: {} }, exit: { show: {} }, monthly: { show: {} } };
  for (const type of ['entry', 'exit', 'monthly']) {
    for (const f of RECEIPT_FIELDS) {
      const v = cfg[type]?.show?.[f];
      if (typeof v === 'boolean') out[type].show[f] = v;
    }
  }
  for (const k of RECEIPT_LABELS) {
    const v = cfg.labels?.[k];
    if (typeof v === 'string' && v.trim()) out.labels[k] = v.trim().slice(0, 24);
  }
  for (const k of ['message', 'entryMessage', 'monthlyMessage']) {
    if (typeof cfg[k] === 'string' && cfg[k].trim()) out[k] = cfg[k].trim().slice(0, 300);
  }
  return out;
}

async function getSiteSettings(req, rawSiteId) {
  const siteId = Number.parseInt(rawSiteId, 10);
  await assertSiteAccess(req, siteId);
  const { rows } = await query('SELECT * FROM sites WHERE id = $1', [siteId]);
  if (!rows[0]) throw new HttpError(404, 'Sede no encontrada', { code: 'NOT_FOUND' });
  const s = rows[0];
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    legalId: s.legal_id,
    phone: s.phone,
    address: s.address,
    city: s.city,
    capacity: s.capacity,
    receiptPrefix: s.receipt_prefix,
    monthlyReceiptPrefix: s.monthly_receipt_prefix,
    businessHours: s.business_hours,
    opExpenseLimit: s.op_expense_limit,
    receiptConfig: sanitizeReceiptConfig(s.receipt_config),
  };
}

async function updateSiteSettings(req, rawSiteId, body) {
  const siteId = Number.parseInt(rawSiteId, 10);
  await assertSiteAccess(req, siteId);
  const b = body ?? {};
  const before = await getSiteSettings(req, siteId);
  const next = { ...before };
  const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
  if (b.name !== undefined) {
    next.name = text(b.name, 80);
    if (!next.name) throw new HttpError(400, 'El nombre del local es obligatorio', { code: 'VALIDATION_ERROR' });
  }
  if (b.legalId !== undefined) next.legalId = text(b.legalId, 30);
  if (b.phone !== undefined) next.phone = text(b.phone, 40);
  if (b.address !== undefined) next.address = text(b.address, 120);
  if (b.city !== undefined) next.city = text(b.city, 60);
  if (b.businessHours !== undefined) next.businessHours = text(b.businessHours, 300);
  if (b.capacity !== undefined) {
    if (!Number.isInteger(b.capacity) || b.capacity < 0 || b.capacity > 100000) {
      throw new HttpError(400, 'Capacidad inválida', { code: 'VALIDATION_ERROR' });
    }
    next.capacity = b.capacity;
  }
  if (b.opExpenseLimit !== undefined) {
    if (!Number.isInteger(b.opExpenseLimit) || b.opExpenseLimit < 0 || b.opExpenseLimit > MAX_MONEY) {
      throw new HttpError(400, 'Tope de egreso inválido', { code: 'VALIDATION_ERROR' });
    }
    next.opExpenseLimit = b.opExpenseLimit;
  }
  if (b.receiptConfig !== undefined) next.receiptConfig = sanitizeReceiptConfig(b.receiptConfig);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE sites SET name = $2, legal_id = $3, phone = $4, address = $5, city = $6, capacity = $7,
              business_hours = $8, op_expense_limit = $9, receipt_config = $10
        WHERE id = $1`,
      [siteId, next.name, next.legalId, next.phone, next.address, next.city, next.capacity, next.businessHours,
        next.opExpenseLimit, next.receiptConfig],
    );
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    await recordAudit(
      { req, userId: req.user.id, siteId, action: 'SITE_SETTINGS_UPDATED', entityType: 'site', entityId: siteId, details: { changed } },
      client,
    );
  });
  return getSiteSettings(req, siteId);
}

module.exports = { listRates, createRate, cancelScheduledRate, getSiteSettings, updateSiteSettings, sanitizeReceiptConfig };
