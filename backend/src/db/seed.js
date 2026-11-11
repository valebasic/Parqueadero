// Datos iniciales: sede Facaparking, su zona, tarifas de la v1.0 (mvc/model.js), consecutivos
// de recibos y el usuario AG inicial "Felipe". Se puede ejecutar varias veces sin duplicar nada.
// La contraseña de Felipe sale de SEED_ADMIN_PASSWORD (.env); nunca está en el código.
const bcrypt = require('bcrypt');
const { withTransaction } = require('./pool');

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 8;

const SITE = {
  code: 'FACA',
  name: 'Facaparking',
  legalId: '35529806-9',
  phone: '3137139757',
  address: 'CARRERA 3 # 7 -132',
  city: 'Facatativá',
  capacity: 100,
  receiptPrefix: 'FA',
  monthlyReceiptPrefix: 'FM',
};

const DEFAULT_ZONE = { name: 'Principal', description: 'Zona general de la sede' };

// Tarifas vigentes de la v1.0 (defaults.services en mvc/model.js). Montos en COP.
const RATES = [
  { vehicleType: 'CAR', fraction: 1800, hour: 3300, full12h: 20000, monthly: 130000, pricingMode: 'normal' },
  { vehicleType: 'MOTORCYCLE', fraction: 1500, hour: 2200, full12h: 14000, monthly: 80000, pricingMode: 'normal' },
  // Cicla: $ 10.000 por cada bloque de 12 h o fracción iniciado
  { vehicleType: 'BICYCLE', fraction: 0, hour: 0, full12h: 10000, monthly: 0, pricingMode: 'block12h' },
];
// Las tarifas iniciales rigen "desde siempre" para cubrir también los datos que se migren de la v1.0
const RATES_VALID_FROM = '2020-01-01T00:00:00-05:00';

const ADMIN = { username: 'Felipe', fullName: 'Felipe', role: 'AG' };

function readAdminPassword() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_ADMIN_PASSWORD debe estar en backend/.env y tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    );
  }
  return password;
}

async function seed({ log = console.log } = {}) {
  const password = readAdminPassword();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  return withTransaction(async (client) => {
    // Sede
    const siteRes = await client.query(
      `INSERT INTO sites (code, name, legal_id, phone, address, city, capacity, receipt_prefix, monthly_receipt_prefix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [SITE.code, SITE.name, SITE.legalId, SITE.phone, SITE.address, SITE.city, SITE.capacity,
        SITE.receiptPrefix, SITE.monthlyReceiptPrefix],
    );
    const siteId = siteRes.rows[0].id;

    // Zona por defecto
    await client.query(
      `INSERT INTO zones (site_id, name, description, capacity)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id, name) DO NOTHING`,
      [siteId, DEFAULT_ZONE.name, DEFAULT_ZONE.description, SITE.capacity],
    );

    // Tarifas (solo si ese tipo de vehículo aún no tiene ninguna)
    for (const r of RATES) {
      await client.query(
        `INSERT INTO rates (site_id, vehicle_type, fraction_amount, hour_amount, full_12h_amount, monthly_amount,
                            pricing_mode, valid_from)
         SELECT $1::integer, $2::vehicle_type, $3::integer, $4::integer, $5::integer, $6::integer, $7::text, $8::timestamptz
         WHERE NOT EXISTS (SELECT 1 FROM rates WHERE site_id = $1::integer AND vehicle_type = $2::vehicle_type)`,
        [siteId, r.vehicleType, r.fraction, r.hour, r.full12h, r.monthly, r.pricingMode, RATES_VALID_FROM],
      );
    }

    // Consecutivos de recibos
    await client.query(
      `INSERT INTO receipt_counters (site_id, prefix) VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
      [siteId, SITE.receiptPrefix, SITE.monthlyReceiptPrefix],
    );

    // Usuario AG inicial (si ya existe no se toca su contraseña)
    const userRes = await client.query(
      `INSERT INTO users (username, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ((lower(username))) DO NOTHING
       RETURNING id`,
      [ADMIN.username, ADMIN.fullName, passwordHash, ADMIN.role],
    );
    const adminCreated = userRes.rowCount === 1;

    if (adminCreated) {
      await client.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
         VALUES (NULL, 'SEED_ADMIN_CREATED', 'user', $1, $2)`,
        [String(userRes.rows[0].id), { username: ADMIN.username, role: ADMIN.role }],
      );
    }

    log(`Seed aplicado: sede ${SITE.name} (id ${siteId}), ${RATES.length} tarifas, ` +
      `usuario ${ADMIN.username} ${adminCreated ? 'creado' : 'ya existía (contraseña sin cambios)'}.`);
    return { siteId, adminCreated };
  });
}

module.exports = { seed, RATES, SITE };

if (require.main === module) {
  const { closePool } = require('./pool');
  seed()
    .catch((err) => {
      console.error(err.message || err.code || err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
