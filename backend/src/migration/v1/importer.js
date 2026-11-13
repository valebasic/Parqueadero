// Importador de datos de la v1.0 (localStorage de Electron) a la v2.0.
//
// Todo corre en UNA transacción:
//   - --dry-run: se hace todo, se arma el reporte y se revierte (ROLLBACK). No queda nada.
//   - real: al final se comparan, por categoría, los conteos y totales en COP de la base antes y después
//     contra lo importado. Si no cuadran, se revierte completa.
// Idempotente: cada registro importado queda en v1_import_map (sede, entidad, id v1); si ya está, se
// omite. Correrla dos veces no duplica nada.
//
// Orden: usuarios → configuración y tarifas → cierres (turno + caja) → mensualidades → pagos de
// mensualidad → entradas/ventas (+ cargos pendientes) → ingresos, egresos y base → consecutivos.
const crypto = require('crypto');
const { getPool } = require('../../db/pool');
const { recordAudit } = require('../../services/audit.service');
const { hashPassword, legacyV1Hash, isLegacyV1Hash, verifyLegacyV1 } = require('../../services/password.service');
const { sanitizeReceiptConfig } = require('../../services/config.service');
const { normalizePlate, detectVehicleType, plateError } = require('../../lib/plates');
const src = require('./source');

const SYSTEM_USERNAME = 'migracion.v1';
const ROLE_MAP = { superadmin: 'AG', administrador: 'AS', empleado: 'OP' };
// Cuentas que la v1.0 crea solas al instalarse (ensure() y defaults.user de mvc/model.js)
const DEFAULT_ACCOUNTS = { admin: 'admin', felipe: '259148637' };

// Categorías del reporte: cómo se cuentan en la base (por sede) antes y después
const CATEGORIES = {
  usuarios: { label: 'Usuarios', sql: `SELECT count(*) AS n, 0 AS t FROM users WHERE username <> '${SYSTEM_USERNAME}'`, global: true },
  ventas: { label: 'Ventas (salidas cobradas)', sql: "SELECT count(*) AS n, COALESCE(sum(charged_amount), 0) AS t FROM entries WHERE site_id = $1 AND status = 'PAID'" },
  pendientes: { label: 'Cobros pendientes', sql: 'SELECT count(*) AS n, COALESCE(sum(amount), 0) AS t FROM pending_charges WHERE site_id = $1 AND confirmed_at IS NULL' },
  adentro: { label: 'Vehículos adentro (entradas abiertas)', sql: "SELECT count(*) AS n, 0 AS t FROM entries WHERE site_id = $1 AND status = 'OPEN'" },
  mensualidades: { label: 'Mensualidades', sql: 'SELECT count(*) AS n, COALESCE(sum(amount), 0) AS t FROM monthly_plans WHERE site_id = $1' },
  pagos_mensualidad: { label: 'Pagos de mensualidad', sql: 'SELECT count(*) AS n, COALESCE(sum(amount), 0) AS t FROM monthly_payments WHERE site_id = $1' },
  ingresos: { label: 'Ingresos', movement: 'INCOME' },
  egresos: { label: 'Egresos', movement: 'EXPENSE' },
  base_mas: { label: 'Base +', movement: 'BASE_IN' },
  base_menos: { label: 'Base −', movement: 'BASE_OUT' },
  cierres: {
    label: 'Cierres de caja (efectivo contado)',
    sql: 'SELECT count(*) AS n, COALESCE(sum(physical_cash), 0) AS t FROM cash_registers WHERE site_id = $1 AND closed_at IS NOT NULL',
  },
};
for (const c of Object.values(CATEGORIES)) {
  if (c.movement) {
    c.sql = `SELECT count(*) AS n, COALESCE(sum(m.amount), 0) AS t FROM cash_movements m
               JOIN cash_registers cr ON cr.id = m.cash_register_id
              WHERE cr.site_id = $1 AND m.type = '${c.movement}' AND m.deleted_at IS NULL`;
  }
}

const MOVEMENT_KEYS = [
  ['fp_incomes', 'INCOME', 'ingresos'],
  ['fp_expenses', 'EXPENSE', 'egresos'],
  ['fp_base_in', 'BASE_IN', 'base_mas'],
  ['fp_base_out', 'BASE_OUT', 'base_menos'],
];

class ImportAborted extends Error {}

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------

function newReport() {
  const categories = {};
  for (const [key, c] of Object.entries(CATEGORIES)) {
    categories[key] = {
      label: c.label,
      v1: { count: 0, total: 0 },
      imported: { count: 0, total: 0 },
      skipped: { count: 0, total: 0 },
      rejected: { count: 0, total: 0 },
      db: { before: null, after: null, delta: null },
      balanced: null,
    };
  }
  return { categories, rejected: [], skipped: [], warnings: [], config: [], users: [] };
}

const add = (bucket, amount) => {
  bucket.count += 1;
  bucket.total += amount || 0;
};

// ---------------------------------------------------------------------------
// Importador
// ---------------------------------------------------------------------------

class V1Importer {
  constructor(client, data, options) {
    this.client = client;
    this.data = data;
    this.options = options;
    this.report = newReport();
    this.userByName = new Map(); // nombre o usuario v1 (minúsculas) → id v2
    this.registerMap = new Map(); // registerId v1 → cash_register_id v2
    this.planMap = new Map(); // id mensualidad v1 → id v2
    this.openRegisterId = null; // caja que estaba abierta en la v1.0 al exportar
  }

  q(text, params) {
    return this.client.query(text, params);
  }

  // --- Contabilidad de cada registro ---------------------------------------
  seen(category, amount) {
    add(this.report.categories[category].v1, amount);
  }

  imported(category, amount) {
    add(this.report.categories[category].imported, amount);
  }

  skip(category, v1Id, reason, amount = 0) {
    add(this.report.categories[category].skipped, amount);
    this.report.skipped.push({ category, v1Id: v1Id == null ? null : String(v1Id), reason });
  }

  reject(category, v1Id, reason, amount = 0) {
    add(this.report.categories[category].rejected, amount);
    this.report.rejected.push({ category, v1Id: v1Id == null ? null : String(v1Id), reason, amount });
  }

  warn(category, v1Id, message) {
    this.report.warnings.push({ category, v1Id: v1Id == null ? null : String(v1Id), message });
  }

  // --- Registro v1 → v2 -----------------------------------------------------
  async mapped(entity, v1Key) {
    const { rows } = await this.q('SELECT v2_id FROM v1_import_map WHERE site_id = $1 AND entity = $2 AND v1_key = $3', [
      this.site.id,
      entity,
      String(v1Key),
    ]);
    return rows[0] ? { v2Id: rows[0].v2_id } : null;
  }

  async remember(entity, v1Key, v2Id) {
    await this.q('INSERT INTO v1_import_map (site_id, entity, v1_key, v2_id, run_id) VALUES ($1, $2, $3, $4, $5)', [
      this.site.id,
      entity,
      String(v1Key),
      v2Id,
      this.runId,
    ]);
  }

  // Ejecuta fn en un SAVEPOINT: un error de base en un registro lo rechaza sin dañar el resto
  async attempt(category, v1Id, amount, fn) {
    await this.q('SAVEPOINT rec');
    try {
      const out = await fn();
      await this.q('RELEASE SAVEPOINT rec');
      return out;
    } catch (err) {
      await this.q('ROLLBACK TO SAVEPOINT rec');
      if (err instanceof ImportAborted) throw err;
      this.reject(category, v1Id, `error de base de datos: ${err.detail || err.message}`, amount);
      return undefined;
    }
  }

  userId(name) {
    if (name == null) return this.systemUserId;
    return this.userByName.get(String(name).trim().toLowerCase()) ?? this.systemUserId;
  }

  // --- Preparación ----------------------------------------------------------
  async prepare() {
    const { rows: site } = await this.q('SELECT * FROM sites WHERE code = $1', [this.options.siteCode]);
    if (!site[0]) throw new ImportAborted(`No existe la sede ${this.options.siteCode}`);
    this.site = site[0];
    const { rows: zone } = await this.q('SELECT id FROM zones WHERE site_id = $1 AND is_active ORDER BY id LIMIT 1', [this.site.id]);
    if (!zone[0]) throw new ImportAborted(`La sede ${this.site.code} no tiene zonas activas`);
    this.zoneId = zone[0].id;

    // Usuario de sistema para lo que la v1.0 no atribuye a nadie (p. ej. quién registró una entrada)
    const { rows: sys } = await this.q('SELECT id FROM users WHERE lower(username) = $1', [SYSTEM_USERNAME]);
    if (sys[0]) this.systemUserId = sys[0].id;
    else {
      const hash = await hashPassword(crypto.randomBytes(32).toString('hex'));
      const { rows } = await this.q(
        `INSERT INTO users (username, full_name, password_hash, role, is_active) VALUES ($1, 'Migración v1.0', $2, 'OP', false) RETURNING id`,
        [SYSTEM_USERNAME, hash],
      );
      this.systemUserId = rows[0].id;
    }

    const reg = this.data.fp_cash_register;
    if (reg && typeof reg === 'object' && reg.id) {
      this.openRegisterId = String(reg.id);
      this.warn('cierres', reg.id, 'La v1.0 tenía una caja ABIERTA al exportar: sus ventas y movimientos se rechazan. Ciérrela en la v1.0 y exporte de nuevo.');
    }

    const { rows: run } = await this.q(
      `INSERT INTO v1_import_runs (site_id, file_name, file_sha256, exported_at, report) VALUES ($1, $2, $3, $4, '{}') RETURNING id`,
      [this.site.id, this.options.fileName ?? null, this.options.sha256, src.parseDateTime(this.options.meta?.exportedAt) ?? null],
    );
    this.runId = rows0(run).id;
  }

  async measure(when) {
    for (const [key, c] of Object.entries(CATEGORIES)) {
      const { rows } = await this.q(c.sql, c.global ? [] : [this.site.id]);
      this.report.categories[key].db[when] = { count: Number(rows[0].n), total: Number(rows[0].t) };
    }
  }

  // --- Usuarios -------------------------------------------------------------
  async importUsers() {
    const users = src.list(this.data, 'fp_users');
    const taken = new Set();
    for (const u of users) {
      const original = String(u.username ?? '').trim();
      const key = original.toLowerCase();
      this.seen('usuarios', 0);
      if (!original) {
        this.reject('usuarios', null, 'usuario sin nombre de usuario');
        continue;
      }
      const prior = await this.mapped('user', key);
      if (prior) {
        this.rememberNames(u, prior.v2Id);
        this.skip('usuarios', original, 'ya importado');
        continue;
      }
      const username = sanitizeUsername(original);
      if (!username) {
        this.reject('usuarios', original, 'nombre de usuario inválido (mínimo 3 letras o números)');
        continue;
      }
      if (taken.has(username.toLowerCase())) {
        this.reject('usuarios', original, `usuario duplicado en el archivo (${username})`);
        continue;
      }
      taken.add(username.toLowerCase());
      const role = ROLE_MAP[String(u.role ?? '').trim().toLowerCase()];
      if (!role) {
        this.reject('usuarios', original, `rol desconocido: ${u.role}`);
        continue;
      }

      const { rows: existing } = await this.q('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
      if (existing[0]) {
        // La cuenta ya existe en la v2.0 (p. ej. Felipe del seed): se conserva y se usa para atribuir
        await this.remember('user', key, existing[0].id);
        this.rememberNames(u, existing[0].id);
        this.skip('usuarios', original, `ya existe en la v2.0 como ${username}: se conserva la cuenta actual`);
        continue;
      }

      const raw = typeof u.password === 'string' ? u.password : '';
      if (!raw) {
        this.reject('usuarios', original, 'usuario sin contraseña');
        continue;
      }
      let legacy = raw.toLowerCase();
      if (!isLegacyV1Hash(legacy)) {
        // Instalaciones viejas guardaban la contraseña en texto plano: se convierte al formato v1 con sal
        legacy = legacyV1Hash(raw);
        this.warn('usuarios', original, 'contraseña en texto plano en la v1.0: se guardó con hash (formato v1) hasta su primer inicio de sesión');
      }
      const defaultPassword = DEFAULT_ACCOUNTS[key];
      const isDefault = defaultPassword != null && verifyLegacyV1(defaultPassword, legacy);
      if (isDefault) this.warn('usuarios', original, 'cuenta por defecto de la v1.0 con su contraseña de fábrica: se importa DESACTIVADA');

      const fullName = String(u.name ?? '').trim() || username;
      const userId = await this.attempt('usuarios', original, 0, async () => {
        const { rows } = await this.q(
          `INSERT INTO users (username, full_name, legacy_password_hash, role, is_active, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [username, fullName.slice(0, 120), legacy, role, !isDefault, this.systemUserId],
        );
        if (role !== 'AG') await this.q('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)', [rows[0].id, this.site.id]);
        await this.remember('user', key, rows[0].id);
        return rows[0].id;
      });
      if (!userId) continue;
      this.rememberNames(u, userId);
      this.imported('usuarios', 0);
      this.report.users.push({ v1: original, username, role, active: !isDefault });
      if (username !== original) this.warn('usuarios', original, `el usuario quedó como "${username}" (la v2.0 solo admite letras, números, punto, guion y guion bajo)`);
    }
  }

  rememberNames(u, id) {
    for (const n of [u.username, u.name]) {
      const k = String(n ?? '').trim().toLowerCase();
      if (k && !this.userByName.has(k)) this.userByName.set(k, id);
    }
  }

  // --- Configuración de la sede, recibos y tarifas -------------------------
  async importConfig() {
    const cfg = this.data.fp_config && typeof this.data.fp_config === 'object' ? this.data.fp_config : null;
    if (cfg) {
      const text = (...vals) => {
        for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
        return null;
      };
      const prefix = (v) => (typeof v === 'string' && /^[A-Z]{1,5}$/.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : null);
      const capacity = Number.parseInt(cfg.limiteVehiculos ?? cfg.capacity, 10);
      const fields = {
        name: text(cfg.razon_social, cfg.parkingName),
        legal_id: text(cfg.receiptNit, cfg.nit),
        phone: text(cfg.receiptPhone, cfg.telefonos, cfg.phone),
        address: text(cfg.receiptAddress, cfg.direccion1, cfg.address),
        capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : null,
        receipt_prefix: prefix(cfg.receiptPrefix),
        monthly_receipt_prefix: prefix(cfg.receiptPrefixMonthly),
        business_hours: text(cfg.entryHoursText),
      };
      const changes = Object.entries(fields).filter(([k, v]) => v != null && v !== this.site[k]);
      const receiptConfig = sanitizeReceiptConfig(mergeReceiptConfig(this.site.receipt_config ?? {}, v1ReceiptConfig(cfg)));
      const receiptChanged = JSON.stringify(receiptConfig) !== JSON.stringify(sanitizeReceiptConfig(this.site.receipt_config ?? {}));
      if (changes.length || receiptChanged) {
        const sets = changes.map(([k], i) => `${k} = $${i + 2}`);
        if (receiptChanged) sets.push(`receipt_config = $${changes.length + 2}`);
        const params = [this.site.id, ...changes.map(([, v]) => v)];
        if (receiptChanged) params.push(receiptConfig);
        await this.q(`UPDATE sites SET ${sets.join(', ')} WHERE id = $1`, params);
        for (const [k, v] of changes) this.report.config.push({ item: `sede.${k}`, from: this.site[k] ?? null, to: v });
        if (receiptChanged) this.report.config.push({ item: 'sede.receipt_config', to: 'configuración de recibos de la v1.0' });
        const { rows } = await this.q('SELECT * FROM sites WHERE id = $1', [this.site.id]);
        this.site = rows[0];
      }
    }

    // Tarifas (fp_services): si cambian, se cierra la vigente y se crea una nueva desde ahora
    for (const s of src.list(this.data, 'fp_services')) {
      const vehicle = src.vehicleType(s.id) ?? src.vehicleType(s.code);
      if (!vehicle) {
        this.warn('config', s.id, `tarifa con servicio desconocido (${s.code ?? s.id}): no se importa`);
        continue;
      }
      const values = {
        fraction_amount: src.money(s.fraction ?? s.minute) ?? 0,
        hour_amount: src.money(s.hour ?? s.valorHora) ?? 0,
        full_12h_amount: src.money(s.full12h) ?? 0,
        monthly_amount: src.money(s.monthly ?? s.mensualidad) ?? 0,
      };
      const { rows: current } = await this.q(
        `SELECT * FROM rates WHERE site_id = $1 AND vehicle_type = $2 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
        [this.site.id, vehicle],
      );
      const cur = current[0];
      if (cur && Object.entries(values).every(([k, v]) => cur[k] === v)) continue;
      const { rows: future } = await this.q('SELECT 1 FROM rates WHERE site_id = $1 AND vehicle_type = $2 AND valid_from > now()', [
        this.site.id,
        vehicle,
      ]);
      if (future[0]) {
        this.warn('config', vehicle, `hay un cambio de tarifa programado para ${vehicle} en la v2.0: no se toca`);
        continue;
      }
      const pricingMode = cur?.pricing_mode ?? (vehicle === 'BICYCLE' ? 'block12h' : 'normal');
      if (pricingMode === 'block12h' && values.full_12h_amount === 0) {
        this.warn('config', vehicle, 'tarifa de cicla por bloques sin tarifa plena en la v1.0: no se importa');
        continue;
      }
      if (cur) await this.q('UPDATE rates SET valid_to = now() WHERE id = $1', [cur.id]);
      await this.q(
        `INSERT INTO rates (site_id, vehicle_type, fraction_amount, hour_amount, full_12h_amount, monthly_amount, pricing_mode, valid_from, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
        [this.site.id, vehicle, values.fraction_amount, values.hour_amount, values.full_12h_amount, values.monthly_amount, pricingMode, this.systemUserId],
      );
      this.report.config.push({ item: `tarifa.${vehicle}`, from: cur ? pick(cur, Object.keys(values)) : null, to: values });
    }
  }

  // --- Cierres de caja → turno + caja cerrados -----------------------------
  async importClosures() {
    const closings = [...src.list(this.data, 'fp_cash_closings'), ...src.list(this.data, 'fp_closures')];
    const done = new Set();
    for (const c of closings) {
      const key = String(c.registerId ?? c.id ?? '');
      const physical = src.money(c.physicalCash);
      this.seen('cierres', physical ?? 0);
      if (!key) {
        this.reject('cierres', c.id, 'cierre sin identificador de caja', physical ?? 0);
        continue;
      }
      if (done.has(key)) {
        this.skip('cierres', key, 'cierre repetido en el archivo', physical ?? 0);
        continue;
      }
      done.add(key);
      const prior = await this.mapped('closure', key);
      if (prior) {
        this.registerMap.set(key, prior.v2Id);
        this.skip('cierres', key, 'ya importado', physical ?? 0);
        continue;
      }
      const openedAt = src.parseDateTime(c.openedAt);
      const closedAt = src.parseDateTime(c.closedAt);
      if (!openedAt || !closedAt) {
        this.reject('cierres', key, 'fecha de apertura o cierre inválida', physical ?? 0);
        continue;
      }
      if (closedAt < openedAt) {
        this.reject('cierres', key, 'el cierre es anterior a la apertura', physical ?? 0);
        continue;
      }
      if (physical == null) {
        this.reject('cierres', key, 'cierre sin efectivo contado', 0);
        continue;
      }
      const initial = src.money(c.initialCash) ?? 0;
      const baseIn = src.money(c.baseAdded) ?? 0;
      const baseOut = src.money(c.baseRemoved) ?? 0;
      const totalSales = src.money(c.totalSales) ?? 0;
      const electronic = src.money(c.totalElectronic) ?? 0;
      const expected = Math.round(Number(c.expectedCash) || 0);
      const baseFinal = Number.isFinite(Number(c.baseFinal)) ? Math.round(Number(c.baseFinal)) : initial + baseIn - baseOut;
      const summary = {
        source: 'v1',
        initialCash: initial,
        baseIn,
        baseOut,
        baseFinal,
        cashSales: totalSales - electronic,
        electronicSales: electronic,
        totalSales,
        discounts: null,
        salesCount: Number.isInteger(c.receiptCount) ? c.receiptCount : null,
        incomes: src.money(c.totalIngresosManuales) ?? 0,
        expenses: src.money(c.totalEgresos) ?? 0,
        // En la v1.0 el esperado no incluye la base: la diferencia se calculó contra el esperado
        expectedCash: expected,
        expectedInDrawer: baseFinal + expected,
        physicalCash: physical,
        difference: Math.round(Number(c.difference) || physical - expected),
        receipts: c.receiptStart != null ? { start: c.receiptStart, end: c.receiptEnd, count: c.receiptCount } : null,
        v1: { id: c.id ?? null, registerId: c.registerId ?? null, openedBy: c.openedBy ?? null, closedBy: c.closedBy ?? null, status: c.status ?? null },
      };
      const registerId = await this.attempt('cierres', key, physical, async () => {
        const { rows: sh } = await this.q(
          `INSERT INTO shifts (site_id, zone_id, user_id, opened_at, closed_at, close_type, notes)
           VALUES ($1, $2, $3, $4, $5, 'CLOSE', $6) RETURNING id`,
          [this.site.id, this.zoneId, this.userId(c.openedBy), openedAt, closedAt, `Importado de la v1.0 (caja ${key})`],
        );
        const { rows: cr } = await this.q(
          `INSERT INTO cash_registers (site_id, shift_id, opened_at, opened_by, initial_cash, closed_at, closed_by,
                                       physical_cash, expected_cash, difference, summary, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [this.site.id, sh[0].id, openedAt, this.userId(c.openedBy), initial, closedAt, this.userId(c.closedBy),
            physical, expected, summary.difference, summary, c.observation ? String(c.observation).slice(0, 500) : null],
        );
        await this.remember('closure', key, cr[0].id);
        return cr[0].id;
      });
      if (!registerId) continue;
      this.registerMap.set(key, registerId);
      this.imported('cierres', physical);
    }

    // Cajas ya importadas en una corrida anterior que no vinieron en este archivo
    const { rows } = await this.q("SELECT v1_key, v2_id FROM v1_import_map WHERE site_id = $1 AND entity = 'closure'", [this.site.id]);
    for (const r of rows) if (!this.registerMap.has(r.v1_key)) this.registerMap.set(r.v1_key, r.v2_id);
  }

  // Caja v2 de un registerId v1: { id } | { open: true } | { missing: true } | { none: true }
  register(v1RegisterId) {
    if (v1RegisterId == null || v1RegisterId === '') return { none: true };
    const key = String(v1RegisterId);
    if (key === this.openRegisterId) return { open: true };
    const id = this.registerMap.get(key);
    return id ? { id } : { missing: true };
  }

  // --- Mensualidades ------------------------------------------------------
  async importMonthlyPlans() {
    // La más reciente primero: si hay dos vigentes de la misma placa, se queda la última
    const plans = [...src.list(this.data, 'fp_monthly')].sort(
      (a, b) => String(b.end ?? '').localeCompare(String(a.end ?? '')) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
    );
    for (const m of plans) {
      const key = String(m.id ?? '');
      const amount = src.money(m.value) ?? 0;
      this.seen('mensualidades', amount);
      if (!key) {
        this.reject('mensualidades', null, 'mensualidad sin id', amount);
        continue;
      }
      const prior = await this.mapped('monthly_plan', key);
      if (prior) {
        this.planMap.set(key, prior.v2Id);
        this.skip('mensualidades', key, 'ya importada', amount);
        continue;
      }
      const plate = normalizePlate(m.plate);
      const plateErr = plateError(plate);
      if (plateErr) {
        this.reject('mensualidades', key, `placa inválida (${m.plate ?? ''}): ${plateErr}`, amount);
        continue;
      }
      const clientName = String(m.name ?? '').trim();
      if (!clientName) {
        this.reject('mensualidades', key, 'mensualidad sin nombre del titular', amount);
        continue;
      }
      const end = src.parseDate(m.end);
      let start = src.parseDate(m.start);
      if (!end) {
        this.reject('mensualidades', key, `fecha de vencimiento inválida (${m.end ?? ''})`, amount);
        continue;
      }
      if (!start) {
        const d = new Date(`${end}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() - 1);
        start = d.toISOString().slice(0, 10);
        this.warn('mensualidades', key, `sin fecha de inicio: se tomó un mes antes del vencimiento (${start})`);
      }
      if (end < start) {
        this.reject('mensualidades', key, 'el vencimiento es anterior al inicio', amount);
        continue;
      }
      const night = String(m.schedule ?? '').toLowerCase() === 'night';
      const nightStart = night ? src.hhmm(m.nightEntryLimit) : null;
      const nightEnd = night ? src.hhmm(m.nightExitLimit) : null;
      if (night && (!nightStart || !nightEnd)) {
        this.reject('mensualidades', key, 'horario de noche sin hora de entrada y salida válidas', amount);
        continue;
      }
      const vehicle = src.vehicleType(m.vehicle) ?? detectVehicleType(plate);
      const pendingConfirmation = m.pendingConfirmation === true;
      const isActive = pendingConfirmation || m.active !== false;

      if (isActive) {
        const { rows: dup } = await this.q(
          `SELECT id, client_name, end_date FROM monthly_plans
            WHERE site_id = $1 AND plate = $2 AND deleted_at IS NULL AND is_active
              AND GREATEST(end_date, COALESCE(next_period_end, end_date)) + 3 >= $3::date
              AND start_date <= $4::date + 3
            LIMIT 1`,
          [this.site.id, plate, start, end],
        );
        if (dup[0]) {
          this.reject('mensualidades', key, `mensualidad duplicada: la placa ${plate} ya tiene una vigente (${dup[0].client_name}, vence ${dup[0].end_date})`, amount);
          continue;
        }
      }

      const inst = m.installment && typeof m.installment === 'object' ? m.installment : null;
      const instPaid = inst ? src.money(inst.paid) ?? 0 : 0;
      const instTotal = inst ? src.money(inst.total) ?? 0 : 0;
      const instStart = inst ? src.parseDate(inst.targetStart) : null;
      const instEnd = inst ? src.parseDate(inst.targetEnd) : null;
      const openInstallment = inst && instPaid > 0 && instPaid < instTotal && instStart && instEnd;
      let status = 'PENDING';
      if (pendingConfirmation) status = 'PENDING_CONFIRMATION';
      else if (openInstallment) status = 'PARTIAL';
      else if (String(m.paymentStatus ?? '').toLowerCase() === 'paid') status = 'PAID';
      if (inst && !openInstallment && !pendingConfirmation && instPaid > 0 && instPaid < instTotal) {
        this.warn('mensualidades', key, 'abono quincenal abierto sin período válido: se importa sin el abono pendiente');
      }
      const next = m.nextPeriod && typeof m.nextPeriod === 'object' ? m.nextPeriod : null;
      const nextStart = next ? src.parseDate(next.start) : null;
      const nextEnd = next && nextStart ? src.parseDate(next.end) : null;
      const phones = String(m.document ?? m.phone ?? '')
        .split(/[^0-9+]+/)
        .filter((p) => p.replace(/\D/g, '').length >= 7)
        .slice(0, 5);

      const planId = await this.attempt('mensualidades', key, amount, async () => {
        const { rows } = await this.q(
          `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, start_date, end_date, amount,
                                      schedule, night_start, night_end, is_active, payment_status, is_biweekly,
                                      installment_due_date, installment_period_start, installment_period_end, installment_paid,
                                      next_period_start, next_period_end, origin, data_consent, created_by, created_at, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                   'V1_MIGRATION', false, $21, COALESCE($22, now()), $23)
           RETURNING id`,
          [this.site.id, plate, vehicle, clientName.slice(0, 120), phones, start, end, amount,
            night ? 'NIGHT' : 'DAY', nightStart, nightEnd, isActive, status, m.biweekly === true || status === 'PARTIAL',
            openInstallment ? src.parseDate(inst.dueDate) : null, openInstallment ? instStart : null, openInstallment ? instEnd : null,
            openInstallment ? instPaid : 0, nextEnd ? nextStart : null, nextEnd ?? null, this.systemUserId,
            src.parseDateTime(m.createdAt), `Importada de la v1.0 (${key})`],
        );
        await this.remember('monthly_plan', key, rows[0].id);
        return rows[0].id;
      });
      if (!planId) continue;
      this.planMap.set(key, planId);
      this.imported('mensualidades', amount);
    }
  }

  // Mensualidad borrada en la v1.0 que tiene pagos: se reconstruye (eliminada) para no perder el pago
  async reconstructPlan(p) {
    const key = `eliminada:${p.monthlyId ?? p.plate}`;
    const prior = await this.mapped('monthly_plan', key);
    if (prior) return prior.v2Id;
    const plate = normalizePlate(p.plate);
    if (plateError(plate)) return null;
    const start = src.parseDate(p.periodStart);
    const end = src.parseDate(p.periodEnd);
    if (!start || !end || end < start) return null;
    const amount = src.money(p.originalValue ?? p.value) ?? 0;
    this.seen('mensualidades', 0);
    const { rows } = await this.q(
      `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount, is_active,
                                  payment_status, origin, created_by, deleted_at, deleted_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'PAID', 'V1_MIGRATION', $8, now(), $8, $9) RETURNING id`,
      [this.site.id, plate, src.vehicleType(p.vehicle) ?? detectVehicleType(plate), String(p.client ?? '').trim() || 'Sin nombre (v1.0)',
        start, end, amount, this.systemUserId, `Reconstruida: la mensualidad ${p.monthlyId ?? ''} se había eliminado en la v1.0 y tenía pagos`],
    );
    await this.remember('monthly_plan', key, rows[0].id);
    this.imported('mensualidades', amount);
    this.warn('mensualidades', p.monthlyId, `la mensualidad ${plate} estaba eliminada en la v1.0 pero tenía pagos: se reconstruyó como eliminada para conservarlos`);
    return rows[0].id;
  }

  async importMonthlyPayments() {
    const payments = [...src.list(this.data, 'fp_monthly_payments')].sort((a, b) =>
      String(a.dateTime ?? '').localeCompare(String(b.dateTime ?? '')),
    );
    const installmentCount = new Map(); // plan|período → abonos vistos
    for (const p of payments) {
      const key = String(p.id ?? '');
      const amount = src.money(p.value);
      this.seen('pagos_mensualidad', amount ?? 0);
      const instKey = `${p.monthlyId}|${p.periodStart}`;
      if (p.isInstallment) installmentCount.set(instKey, (installmentCount.get(instKey) ?? 0) + 1);
      if (!key) {
        this.reject('pagos_mensualidad', null, 'pago sin id', amount ?? 0);
        continue;
      }
      if (await this.mapped('monthly_payment', key)) {
        this.skip('pagos_mensualidad', key, 'ya importado', amount ?? 0);
        continue;
      }
      if (amount == null) {
        this.reject('pagos_mensualidad', key, `valor inválido (${p.value})`, 0);
        continue;
      }
      const number = Number.parseInt(p.receiptNumber, 10);
      const prefix = String(p.receiptPrefix || this.site.monthly_receipt_prefix || 'FM').trim().toUpperCase();
      if (!(number > 0) || !/^[A-Z]{1,5}$/.test(prefix)) {
        this.reject('pagos_mensualidad', key, `recibo inválido (${p.receiptPrefix ?? ''}${p.receiptNumber ?? ''})`, amount);
        continue;
      }
      const paidAt = src.parseDateTime(p.dateTime);
      const start = src.parseDate(p.periodStart);
      const end = src.parseDate(p.periodEnd);
      if (!paidAt || !start || !end || end < start) {
        this.reject('pagos_mensualidad', key, 'fecha de pago o período inválido', amount);
        continue;
      }
      const method = src.paymentMethod(p.paymentMethod);
      if (!method) {
        this.reject('pagos_mensualidad', key, `forma de pago desconocida (${p.paymentMethod ?? 'vacía'})`, amount);
        continue;
      }
      const split = src.splitAmounts(method, amount, p.cashAmount, p.nequiAmount);
      if (split.error) {
        this.reject('pagos_mensualidad', key, split.error, amount);
        continue;
      }
      const { rows: dupReceipt } = await this.q(
        'SELECT 1 FROM monthly_payments WHERE site_id = $1 AND receipt_prefix = $2 AND receipt_number = $3',
        [this.site.id, prefix, number],
      );
      if (dupReceipt[0]) {
        this.reject('pagos_mensualidad', key, `recibo ${prefix}${number} repetido`, amount);
        continue;
      }
      const discount = src.money(p.discountAmount) ?? 0;
      const base = src.money(p.originalValue) ?? amount + discount;

      let planId = this.planMap.get(String(p.monthlyId ?? ''));
      if (!planId) {
        planId = await this.attempt('mensualidades', `eliminada:${p.monthlyId ?? p.plate}`, 0, () => this.reconstructPlan(p));
        if (!planId) {
          this.reject('pagos_mensualidad', key, 'su mensualidad no existe y no se pudo reconstruir (placa o período inválido)', amount);
          continue;
        }
        this.planMap.set(String(p.monthlyId ?? ''), planId);
      }
      const ok = await this.attempt('pagos_mensualidad', key, amount, async () => {
        const { rows } = await this.q(
          `INSERT INTO monthly_payments (site_id, monthly_plan_id, receipt_prefix, receipt_number, period_start, period_end,
                                         base_amount, discount_amount, amount, payment_method, cash_amount, electronic_amount,
                                         installment_number, is_advance, paid_at, paid_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
          [this.site.id, planId, prefix, number, start, end, base, discount, amount, split.method, split.cash, split.electronic,
            p.isInstallment ? Math.min(2, installmentCount.get(instKey)) : null, p.advance === true, paidAt, this.userId(p.user)],
        );
        await this.remember('monthly_payment', key, rows[0].id);
        return true;
      });
      if (ok) this.imported('pagos_mensualidad', amount);
    }
  }

  // --- Entradas / ventas / pendientes -------------------------------------
  async importEntries() {
    const extras = new Map(); // entryId v1 → cargo de fp_monthly_extra_charges
    for (const x of src.list(this.data, 'fp_monthly_extra_charges')) {
      if (x.entryId != null) extras.set(String(x.entryId), x);
    }
    const usedExtras = new Set();
    const seenIds = new Set();
    const all = [...src.list(this.data, 'fp_entries'), ...src.list(this.data, 'fp_entries_archive')];

    for (const e of all) {
      const key = String(e.id ?? '');
      const exitRaw = e.salidaFecha;
      const pending = Boolean(exitRaw) && e.pendingMonthlyConfirmation === true;
      const category = !exitRaw ? 'adentro' : pending ? 'pendientes' : 'ventas';
      const extra = extras.get(key);
      const total = src.money(e.total) ?? 0;
      const amount = category === 'ventas' ? total : category === 'pendientes' ? src.money(extra?.amount) ?? total : 0;
      this.seen(category, amount);
      if (key && seenIds.has(key)) {
        // La v1.0 movía entradas viejas a fp_entries_archive: la misma entrada en los dos lados
        this.skip(category, key, 'entrada repetida (fp_entries y fp_entries_archive)', amount);
        continue;
      }
      if (!key) {
        this.reject(category, null, 'entrada sin id', amount);
        continue;
      }
      seenIds.add(key);
      if (extra) usedExtras.add(String(extra.id));
      if (await this.mapped('entry', key)) {
        this.skip(category, key, 'ya importada', amount);
        continue;
      }
      const reason = await this.entryRejection(e, category, amount, extra);
      if (typeof reason === 'string') {
        this.reject(category, key, reason, amount);
        continue;
      }
      const ok = await this.attempt(category, key, amount, () => this.insertEntry(e, key, category, reason, extra));
      if (ok) this.imported(category, amount);
    }

    // Cargos pendientes cuya entrada no vino en el archivo
    for (const x of src.list(this.data, 'fp_monthly_extra_charges')) {
      if (usedExtras.has(String(x.id))) continue;
      const amount = src.money(x.amount) ?? 0;
      const category = x.confirmed ? 'ventas' : 'pendientes';
      this.seen(category, x.confirmed ? 0 : amount);
      if (await this.mapped('pending_charge', x.id)) {
        this.skip(category, x.id, 'ya importado', x.confirmed ? 0 : amount);
        continue;
      }
      this.reject(category, x.id, `cargo pendiente sin su entrada (entrada ${x.entryId ?? '—'} no está en el archivo)`, x.confirmed ? 0 : amount);
    }
  }

  // Valida una entrada; devuelve el motivo de rechazo (texto) o los datos ya convertidos
  async entryRejection(e, category, amount, extra) {
    const plate = normalizePlate(e.placa ?? e.plate);
    const err = plateError(plate);
    if (err) return `placa inválida (${e.placa ?? e.plate ?? ''}): ${err}`;
    const vehicle = src.vehicleType(e.idTarifa) ?? detectVehicleType(plate);
    const prefix = String(e.reciboPrefijo || this.site.receipt_prefix || 'FA').trim().toUpperCase();
    const number = Number.parseInt(e.reciboNumero ?? e.receiptNumber, 10);
    if (!(number > 0) || !/^[A-Z]{1,5}$/.test(prefix)) return `recibo inválido (${e.reciboPrefijo ?? ''}${e.reciboNumero ?? ''})`;
    const entryAt = src.parseDateTime(e.entradaFecha);
    if (!entryAt) return `fecha de entrada inválida (${e.entradaFecha ?? ''})`;
    let exitAt = null;
    if (category !== 'adentro') {
      exitAt = src.parseDateTime(e.salidaFecha);
      if (!exitAt) return `fecha de salida inválida (${e.salidaFecha})`;
      if (exitAt < entryAt) return 'la salida es anterior a la entrada';
    }
    const { rows: dupReceipt } = await this.q(
      'SELECT 1 FROM entries WHERE site_id = $1 AND receipt_prefix = $2 AND receipt_number = $3',
      [this.site.id, prefix, number],
    );
    if (dupReceipt[0]) return `recibo ${prefix}${number} repetido`;

    const out = { plate, vehicle, prefix, number, entryAt, exitAt, registerId: null, payment: null };
    if (category === 'adentro') {
      const { rows: open } = await this.q(
        `SELECT 1 FROM entries WHERE plate = $1 AND status = 'OPEN' AND (vehicle_type <> 'BICYCLE' OR site_id = $2)`,
        [plate, this.site.id],
      );
      if (open[0]) return `la placa ${plate} ya tiene una entrada abierta en la v2.0`;
      return out;
    }

    const total = src.money(e.total);
    if (total == null) return `valor cobrado inválido (${e.total})`;
    let discount = src.money(e.discountAmount) ?? 0;
    const subtotal = src.money(e.subtotal);
    if (!discount && subtotal != null && subtotal > total) discount = subtotal - total;
    out.total = total;
    out.discount = discount;
    out.calculated = total + discount;
    out.discountReason = String(e.discountReason ?? '').trim();
    if (discount > 0 && out.discountReason.length < 3) {
      out.discountReason = 'Descuento registrado en la v1.0 sin motivo';
      this.warn(category, e.id, `descuento de $${discount} sin motivo en la v1.0: se registró con un motivo genérico`);
    }

    if (category === 'pendientes') return out;

    const reg = this.register(e.registerId);
    if (reg.open) return 'venta de la caja que seguía ABIERTA en la v1.0: cierre la caja y exporte de nuevo';
    if (reg.missing) {
      this.warn('ventas', e.id, `la caja ${e.registerId} no está en el archivo: la venta se importa sin caja`);
    }
    out.registerId = reg.id ?? null;

    let method = src.paymentMethod(e.paymentMethod ?? e.idTipoPago);
    if (!method) {
      // La caja de la v1.0 contaba "Sin método" como no efectivo (cashPart = 0)
      method = 'ELECTRONIC';
      this.warn('ventas', e.id, 'venta "Sin método" en la v1.0: se importa como electrónico (así la contaba la caja v1)');
    }
    const split = src.splitAmounts(method, total, e.cashAmount, e.nequiAmount);
    if (split.error) return split.error;
    out.payment = split;
    out.paidAt = extra?.confirmed ? src.parseDateTime(extra.confirmedAt) ?? exitAt : exitAt;
    if (out.paidAt < exitAt) out.paidAt = exitAt;
    return out;
  }

  async insertEntry(e, key, category, d, extra) {
    const status = { adentro: 'OPEN', pendientes: 'PENDING_CHARGE', ventas: 'PAID' }[category];
    const planId = e.linkedMonthlyId != null ? this.planMap.get(String(e.linkedMonthlyId)) ?? null : null;
    const minutes = d.exitAt ? Math.max(0, Math.round((d.exitAt - d.entryAt) / 60000)) : null;
    const { rows } = await this.q(
      `INSERT INTO entries (site_id, zone_id, plate, vehicle_type, receipt_prefix, receipt_number, status, entry_at, entry_by,
                            exit_at, exit_by, cash_register_id, monthly_plan_id, billed_minutes, calculated_amount,
                            discount_amount, discount_reason, charged_amount, payment_method, cash_amount, electronic_amount,
                            paid_at, origin, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'V1_IMPORT', $23)
       RETURNING id`,
      [this.site.id, this.zoneId, d.plate, d.vehicle, d.prefix, d.number, status, d.entryAt, this.systemUserId,
        d.exitAt, d.exitAt ? this.systemUserId : null, d.registerId, planId, minutes, d.calculated ?? null,
        d.discount ?? 0, d.discount ? d.discountReason : null, d.total ?? null, d.payment?.method ?? null,
        d.payment?.cash ?? 0, d.payment?.electronic ?? 0, status === 'PAID' ? d.paidAt : null, `Importada de la v1.0 (${key})`],
    );
    const entryId = rows[0].id;

    // Cargo pendiente: abierto (por cobrar) o ya confirmado (la venta se cobró desde Pendientes)
    if (category === 'pendientes' || (extra && extra.confirmed)) {
      const confirmed = category === 'ventas';
      if (confirmed && !d.registerId) {
        this.warn('ventas', key, 'cobro confirmado desde Pendientes sin caja conocida: no se registra el cargo pendiente');
      } else {
        await this.q(
          `INSERT INTO pending_charges (site_id, entry_id, monthly_plan_id, plate, amount, reason, created_by, created_at,
                                        confirmed_at, confirmed_by, cash_register_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $9, $10, $11)`,
          [this.site.id, entryId, planId, d.plate, confirmed ? d.total : src.money(extra?.amount) ?? d.total,
            planId || e.linkedMonthlyId ? 'OUT_OF_SCHEDULE' : 'MANUAL', this.systemUserId, src.parseDateTime(extra?.dateTime),
            confirmed ? d.paidAt : null, confirmed ? this.systemUserId : null, confirmed ? d.registerId : null],
        );
      }
      if (extra) await this.remember('pending_charge', extra.id, entryId);
    }
    await this.remember('entry', key, entryId);
    return true;
  }

  // --- Ingresos, egresos y base --------------------------------------------
  async importMovements() {
    for (const [storageKey, type, category] of MOVEMENT_KEYS) {
      for (const x of src.list(this.data, storageKey)) {
        const amount = src.money(x.amount);
        this.seen(category, amount ?? 0);
        const key = `${type}:${x.id ?? ''}`;
        if (x.id == null) {
          this.reject(category, null, 'movimiento sin id', amount ?? 0);
          continue;
        }
        if (await this.mapped('movement', key)) {
          this.skip(category, x.id, 'ya importado', amount ?? 0);
          continue;
        }
        if (!amount) {
          this.reject(category, x.id, `valor inválido (${x.amount})`, amount ?? 0);
          continue;
        }
        const createdAt = src.parseDateTime(x.dateTime);
        if (!createdAt) {
          this.reject(category, x.id, `fecha inválida (${x.dateTime ?? ''})`, amount);
          continue;
        }
        const reg = this.register(x.registerId);
        if (reg.open) {
          this.reject(category, x.id, 'movimiento de la caja que seguía ABIERTA en la v1.0: cierre la caja y exporte de nuevo', amount);
          continue;
        }
        if (!reg.id) {
          this.reject(category, x.id, `su caja (${x.registerId ?? 'sin caja'}) no está en el archivo`, amount);
          continue;
        }
        const ok = await this.attempt(category, x.id, amount, async () => {
          const by = this.userId(x.user);
          const { rows } = await this.q(
            `INSERT INTO cash_movements (cash_register_id, type, amount, concept, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
            [reg.id, type, amount, String(x.concept ?? '').trim().slice(0, 200) || null, by, createdAt],
          );
          await this.remember('movement', key, rows[0].id);
          return true;
        });
        if (ok) this.imported(category, amount);
      }
    }
  }

  // --- Consecutivos -------------------------------------------------------
  async importCounters() {
    const cfg = this.data.fp_config && typeof this.data.fp_config === 'object' ? this.data.fp_config : {};
    const int = (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const targets = [
      [this.site.receipt_prefix, Math.max(int(this.data.facaparking_offline_receipt_v4), int(cfg.nextReceiptNumber) - 1), 'entries'],
      [this.site.monthly_receipt_prefix, Math.max(int(this.data.facaparking_offline_receipt_monthly_v1), int(cfg.nextReceiptNumberMonthly) - 1), 'monthly_payments'],
    ];
    for (const [prefix, v1Last, table] of targets) {
      const { rows: mx } = await this.q(`SELECT COALESCE(max(receipt_number), 0) AS n FROM ${table} WHERE site_id = $1 AND receipt_prefix = $2`, [
        this.site.id,
        prefix,
      ]);
      const target = Math.max(v1Last, Number(mx[0].n));
      const { rows: cur } = await this.q('SELECT last_number FROM receipt_counters WHERE site_id = $1 AND prefix = $2', [this.site.id, prefix]);
      const current = cur[0]?.last_number ?? 0;
      if (target > current) {
        await this.q(
          `INSERT INTO receipt_counters (site_id, prefix, last_number) VALUES ($1, $2, $3)
           ON CONFLICT (site_id, prefix) DO UPDATE SET last_number = GREATEST(receipt_counters.last_number, EXCLUDED.last_number)`,
          [this.site.id, prefix, target],
        );
        this.report.config.push({ item: `consecutivo.${prefix}`, from: current, to: target });
      }
    }
  }

  // --- Cuadre -------------------------------------------------------------
  verify() {
    let balanced = true;
    for (const c of Object.values(this.report.categories)) {
      const { before, after } = c.db;
      c.db.delta = { count: after.count - before.count, total: after.total - before.total };
      c.balanced = c.db.delta.count === c.imported.count && c.db.delta.total === c.imported.total;
      // Cada registro del archivo terminó en exactamente un lado: importado, omitido o rechazado
      const accounted = c.imported.count + c.skipped.count + c.rejected.count;
      c.complete = accounted === c.v1.count;
      if (!c.balanced || !c.complete) balanced = false;
    }
    this.report.balanced = balanced;
    return balanced;
  }

  // Revisión adicional (no bloquea): ventas importadas de cada cierre vs. lo que dice el cierre v1
  async crossCheckClosures() {
    for (const c of [...src.list(this.data, 'fp_cash_closings'), ...src.list(this.data, 'fp_closures')]) {
      const id = this.registerMap.get(String(c.registerId ?? c.id ?? ''));
      if (!id) continue;
      const { rows } = await this.q("SELECT COALESCE(sum(charged_amount), 0) AS t FROM entries WHERE cash_register_id = $1 AND status = 'PAID'", [id]);
      const v1Total = src.money(c.totalSales) ?? 0;
      if (Number(rows[0].t) !== v1Total) {
        this.warn('cierres', c.registerId, `el cierre de la v1.0 suma ventas por $${v1Total} y las ventas importadas de esa caja suman $${rows[0].t}`);
      }
    }
  }
}

function rows0(rows) {
  return rows[0];
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

// Usuario v1 → formato v2 (^[A-Za-z0-9._-]{3,40}$): sin tildes, espacios a punto
function sanitizeUsername(name) {
  const clean = String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ñ/gi, (c) => (c === 'ñ' ? 'n' : 'N'))
    .replace(/\s+/g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.]+|[.]+$/g, '')
    .slice(0, 40);
  return clean.length >= 3 ? clean : null;
}

// Configuración de recibos de la v1.0 (fp_config) → estructura de la v2.0 (sites.receipt_config)
function v1ReceiptConfig(cfg) {
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const label = (...vals) => vals.find((v) => typeof v === 'string' && v.trim());
  const message = [cfg.customMessage, cfg.additionalInfo].filter((v) => typeof v === 'string' && v.trim()).join('\n');
  return {
    entry: { show: { business: bool(cfg.entryShowBusiness), hours: bool(cfg.entryShowHours) } },
    exit: { show: { business: bool(cfg.exitShowBusiness), duration: bool(cfg.exitShowTime) } },
    monthly: { show: { business: bool(cfg.monthlyShowBusiness) } },
    labels: {
      plate: label(cfg.exitLabelPlate, cfg.entryLabelPlate),
      entry: label(cfg.exitLabelEntry, cfg.entryLabelEntry),
      exit: label(cfg.exitLabelExit),
      duration: label(cfg.exitLabelTime),
      total: label(cfg.exitLabelTotal),
      payment: label(cfg.exitLabelPaymentMethod),
      receipt: label(cfg.monthlyLabelReceipt),
      vehicle: label(cfg.monthlyLabelVehicle, cfg.exitLabelService),
    },
    message: message || undefined,
  };
}

function mergeReceiptConfig(current, incoming) {
  const out = JSON.parse(JSON.stringify(current ?? {}));
  for (const type of ['entry', 'exit', 'monthly']) {
    out[type] = out[type] ?? {};
    out[type].show = { ...(out[type].show ?? {}) };
    for (const [k, v] of Object.entries(incoming[type].show)) if (v !== undefined) out[type].show[k] = v;
  }
  out.labels = { ...(out.labels ?? {}) };
  for (const [k, v] of Object.entries(incoming.labels)) if (v !== undefined) out.labels[k] = v;
  if (incoming.message) out.message = incoming.message;
  return out;
}

/**
 * Corre la migración.
 * @param {{ data: object, meta?: object, sha256: string }} parsed  resultado de parseExport
 * @param {object} options
 * @param {string} [options.siteCode='FACA']
 * @param {boolean} [options.dryRun=false]
 * @param {string} [options.fileName]
 * @param {(client) => Promise<void>} [options.beforeVerify]  (pruebas) se ejecuta antes del cuadre
 * @returns {Promise<object>} reporte
 */
async function runImport(parsed, options = {}) {
  const opts = { siteCode: 'FACA', dryRun: false, ...options, sha256: parsed.sha256, meta: parsed.meta };
  const client = await getPool().connect();
  let importer;
  try {
    await client.query('BEGIN');
    // Una migración a la vez
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nexo-v1-import'))");
    importer = new V1Importer(client, parsed.data, opts);
    await importer.prepare();
    await importer.measure('before');
    await importer.importUsers();
    await importer.importConfig();
    await importer.importClosures();
    await importer.importMonthlyPlans();
    await importer.importMonthlyPayments();
    await importer.importEntries();
    await importer.importMovements();
    await importer.importCounters();
    await importer.crossCheckClosures();
    if (opts.beforeVerify) await opts.beforeVerify(client);
    await importer.measure('after');
    const balanced = importer.verify();

    const report = finalReport(importer, opts);
    if (opts.dryRun || !balanced) {
      await client.query('ROLLBACK');
      report.committed = false;
      report.outcome = opts.dryRun ? 'DRY_RUN' : 'ROLLED_BACK_UNBALANCED';
      return report;
    }
    report.committed = true;
    report.outcome = 'COMMITTED';
    await client.query('UPDATE v1_import_runs SET report = $2 WHERE id = $1', [importer.runId, report]);
    await recordAudit(
      {
        userId: importer.systemUserId,
        siteId: importer.site.id,
        action: 'V1_IMPORT',
        entityType: 'v1_import_run',
        entityId: importer.runId,
        details: {
          file: opts.fileName ?? null,
          sha256: opts.sha256,
          imported: Object.fromEntries(Object.entries(report.categories).map(([k, c]) => [k, c.imported])),
          rejected: report.rejected.length,
        },
      },
      client,
    );
    await client.query('COMMIT');
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ImportAborted) {
      const report = importer ? finalReport(importer, opts) : { categories: {} };
      report.committed = false;
      report.outcome = 'ABORTED';
      report.error = err.message;
      return report;
    }
    throw err;
  } finally {
    client.release();
  }
}

function finalReport(importer, opts) {
  const r = importer.report;
  return {
    site: importer.site ? { id: importer.site.id, code: importer.site.code, name: importer.site.name } : null,
    file: { name: opts.fileName ?? null, sha256: opts.sha256, ...opts.meta },
    dryRun: opts.dryRun,
    runId: importer.runId ?? null,
    balanced: r.balanced ?? false,
    categories: r.categories,
    users: r.users,
    config: r.config,
    rejected: r.rejected,
    skipped: r.skipped,
    warnings: r.warnings,
  };
}

module.exports = { runImport, sanitizeUsername, v1ReceiptConfig, CATEGORIES, SYSTEM_USERNAME };
