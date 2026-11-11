// Restricciones del esquema y datos del seed.
const { query, withTransaction, closePool } = require('../../src/db/pool');

let siteId;
let zoneId;
let userId;

beforeAll(async () => {
  ({ rows: [{ id: siteId }] } = await query("SELECT id FROM sites WHERE code = 'FACA'"));
  ({ rows: [{ id: zoneId }] } = await query('SELECT id FROM zones WHERE site_id = $1', [siteId]));
  ({ rows: [{ id: userId }] } = await query("SELECT id FROM users WHERE username = 'Felipe'"));
});

afterAll(closePool);

// Ejecuta fn dentro de una transacción que siempre se revierte, para no dejar datos entre pruebas
async function inRollback(fn) {
  const rollback = new Error('rollback');
  await expect(
    withTransaction(async (client) => {
      await fn(client);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

let receiptCounter = 1000;
function insertEntry(client, { plate, vehicleType = 'CAR', site = siteId, status = 'OPEN' }) {
  receiptCounter += 1;
  return client.query(
    `INSERT INTO entries (site_id, zone_id, plate, vehicle_type, receipt_prefix, receipt_number, entry_by, status, exit_at)
     VALUES ($1, $2, $3, $4, 'FA', $5, $6, $7, CASE WHEN $7 = 'OPEN' THEN NULL ELSE now() END)`,
    [site, site === siteId ? zoneId : null, plate, vehicleType, receiptCounter, userId, status],
  );
}

describe('seed', () => {
  test('crea la sede Facaparking con su zona', async () => {
    const { rows } = await query("SELECT name, city, receipt_prefix FROM sites WHERE code = 'FACA'");
    expect(rows[0]).toEqual({ name: 'Facaparking', city: 'Facatativá', receipt_prefix: 'FA' });
  });

  test('carga las tarifas de la v1.0', async () => {
    const { rows } = await query(
      `SELECT vehicle_type, fraction_amount, hour_amount, full_12h_amount, monthly_amount, pricing_mode
         FROM rates WHERE site_id = $1 AND valid_to IS NULL ORDER BY vehicle_type`,
      [siteId],
    );
    expect(rows).toEqual([
      { vehicle_type: 'BICYCLE', fraction_amount: 0, hour_amount: 0, full_12h_amount: 10000, monthly_amount: 0, pricing_mode: 'block12h' },
      { vehicle_type: 'CAR', fraction_amount: 1800, hour_amount: 3300, full_12h_amount: 20000, monthly_amount: 130000, pricing_mode: 'normal' },
      { vehicle_type: 'MOTORCYCLE', fraction_amount: 1500, hour_amount: 2200, full_12h_amount: 14000, monthly_amount: 80000, pricing_mode: 'normal' },
    ]);
  });

  test('crea a Felipe como AG con contraseña bcrypt de costo 12', async () => {
    const { rows } = await query("SELECT role, password_hash FROM users WHERE username = 'Felipe'");
    expect(rows[0].role).toBe('AG');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
  });

  test('es idempotente: correrlo otra vez no duplica nada', async () => {
    const { seed } = require('../../src/db/seed');
    await seed({ log: () => {} });
    const { rows } = await query(
      `SELECT (SELECT count(*) FROM sites) AS sites, (SELECT count(*) FROM rates) AS rates,
              (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM zones) AS zones`,
    );
    expect(rows[0]).toEqual({ sites: 1, rates: 3, users: 1, zones: 1 });
  });
});

describe('entradas abiertas por placa (índice único parcial)', () => {
  test('rechaza una segunda entrada abierta de la misma placa', async () => {
    await inRollback(async (client) => {
      await insertEntry(client, { plate: 'ABC123' });
      await expect(insertEntry(client, { plate: 'ABC123' })).rejects.toMatchObject({
        code: '23505',
        constraint: 'entries_one_open_per_plate',
      });
    });
  });

  test('la rechaza aunque sea en otra sede', async () => {
    await inRollback(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO sites (code, name) VALUES ('OTRA', 'Otra sede') RETURNING id",
      );
      await insertEntry(client, { plate: 'XYZ987' });
      await expect(insertEntry(client, { plate: 'XYZ987', site: rows[0].id })).rejects.toMatchObject({
        constraint: 'entries_one_open_per_plate',
      });
    });
  });

  test('permite volver a entrar cuando la anterior ya salió', async () => {
    await inRollback(async (client) => {
      await insertEntry(client, { plate: 'DEF456', status: 'CANCELLED' });
      await insertEntry(client, { plate: 'DEF456' });
    });
  });

  test('ciclas: una por placa genérica y por sede', async () => {
    await inRollback(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO sites (code, name) VALUES ('OTRA', 'Otra sede') RETURNING id",
      );
      await insertEntry(client, { plate: 'CICLA', vehicleType: 'BICYCLE' });
      await insertEntry(client, { plate: 'CICLA', vehicleType: 'BICYCLE', site: rows[0].id });
      await expect(
        insertEntry(client, { plate: 'CICLA', vehicleType: 'BICYCLE' }),
      ).rejects.toMatchObject({ constraint: 'entries_one_open_bicycle_per_site' });
    });
  });
});

describe('dominios y restricciones', () => {
  test.each(['abc123', 'ABC-123', 'ABC 123', ''])('rechaza la placa sin normalizar %p', async (plate) => {
    await inRollback(async (client) => {
      await expect(insertEntry(client, { plate })).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('rechaza montos negativos', async () => {
    await inRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO rates (site_id, vehicle_type, hour_amount, valid_from)
           VALUES ($1, 'CAR', -1, '2030-01-01')`,
          [siteId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('rechaza dos tarifas vigentes a la vez para la misma sede y vehículo', async () => {
    await inRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO rates (site_id, vehicle_type, hour_amount, valid_from)
           VALUES ($1, 'CAR', 3500, '2030-01-01')`,
          [siteId],
        ),
      ).rejects.toMatchObject({ constraint: 'rates_no_overlap' });
    });
  });

  test('acepta una tarifa nueva si se cierra la vigencia de la anterior', async () => {
    await inRollback(async (client) => {
      await client.query(
        "UPDATE rates SET valid_to = '2030-01-01' WHERE site_id = $1 AND vehicle_type = 'CAR' AND valid_to IS NULL",
        [siteId],
      );
      await client.query(
        `INSERT INTO rates (site_id, vehicle_type, hour_amount, valid_from)
         VALUES ($1, 'CAR', 3500, '2030-01-01')`,
        [siteId],
      );
    });
  });

  test('una venta cobrada exige que efectivo + electrónico = valor cobrado', async () => {
    await inRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO entries (site_id, plate, vehicle_type, receipt_prefix, receipt_number, entry_by,
                                status, exit_at, charged_amount, payment_method, cash_amount)
           VALUES ($1, 'GHI789', 'CAR', 'FA', 5000, $2, 'PAID', now(), 3300, 'CASH', 3000)`,
          [siteId, userId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('la zona debe pertenecer a la misma sede', async () => {
    await inRollback(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO sites (code, name) VALUES ('OTRA', 'Otra sede') RETURNING id",
      );
      await expect(
        client.query(
          `INSERT INTO entries (site_id, zone_id, plate, vehicle_type, receipt_prefix, receipt_number, entry_by)
           VALUES ($1, $2, 'JKL012', 'CAR', 'FA', 6000, $3)`,
          [rows[0].id, zoneId, userId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  test("'block12h' exige tarifa plena mayor que cero", async () => {
    await inRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO rates (site_id, vehicle_type, pricing_mode, full_12h_amount, valid_from)
           VALUES ($1, 'BICYCLE', 'block12h', 0, '2030-01-01')`,
          [siteId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('usuario único sin distinguir mayúsculas', async () => {
    await inRollback(async (client) => {
      await expect(
        client.query("INSERT INTO users (username, full_name, password_hash, role) VALUES ('felipe', 'Otro', 'x', 'OP')"),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  test('la auditoría es de solo inserción', async () => {
    await inRollback(async (client) => {
      await client.query("INSERT INTO audit_log (action) VALUES ('TEST_EVENT')");
      await expect(client.query('DELETE FROM audit_log')).rejects.toThrow(/solo inserción/);
    });
  });
});

describe('turnos y cajas', () => {
  async function newOperator(client, name) {
    const { rows } = await client.query(
      "INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, $1, 'x', 'OP') RETURNING id",
      [name],
    );
    return rows[0].id;
  }
  async function openShift(client, { user = userId, zone = zoneId } = {}) {
    const { rows } = await client.query(
      'INSERT INTO shifts (site_id, zone_id, user_id) VALUES ($1, $2, $3) RETURNING id',
      [siteId, zone, user],
    );
    await client.query(
      'INSERT INTO cash_registers (site_id, shift_id, opened_by) VALUES ($1, $2, $3)',
      [siteId, rows[0].id, user],
    );
    return rows[0].id;
  }

  test('un usuario no puede tener dos turnos abiertos', async () => {
    await inRollback(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO zones (site_id, name) VALUES ($1, 'Sótano') RETURNING id",
        [siteId],
      );
      await openShift(client);
      await expect(openShift(client, { zone: rows[0].id })).rejects.toMatchObject({
        constraint: 'shifts_one_open_per_user',
      });
    });
  });

  test('una zona no puede tener dos turnos abiertos', async () => {
    await inRollback(async (client) => {
      const other = await newOperator(client, 'operador2');
      await openShift(client);
      await expect(openShift(client, { user: other })).rejects.toMatchObject({
        constraint: 'shifts_one_open_per_zone',
      });
    });
  });

  test('el turno exige zona', async () => {
    await inRollback(async (client) => {
      await expect(
        client.query('INSERT INTO shifts (site_id, user_id) VALUES ($1, $2)', [siteId, userId]),
      ).rejects.toMatchObject({ code: '23502' });
    });
  });

  test('un turno sin caja no se puede confirmar', async () => {
    await expect(
      withTransaction((client) =>
        client.query('INSERT INTO shifts (site_id, zone_id, user_id) VALUES ($1, $2, $3)', [siteId, zoneId, userId])),
    ).rejects.toThrow(/no tiene caja/);
  });

  test('un turno no se puede cerrar con la caja abierta', async () => {
    const shiftId = await withTransaction((client) => openShift(client));
    try {
      await expect(
        withTransaction((client) => client.query('UPDATE shifts SET closed_at = now() WHERE id = $1', [shiftId])),
      ).rejects.toThrow(/caja abierta/);
    } finally {
      // Entrega de turno correcta: se cierra la caja y luego el turno, en la misma transacción
      await withTransaction(async (client) => {
        await client.query(
          'UPDATE cash_registers SET closed_at = now(), closed_by = $2, physical_cash = 0 WHERE shift_id = $1',
          [shiftId, userId],
        );
        await client.query('UPDATE shifts SET closed_at = now() WHERE id = $1', [shiftId]);
      });
    }
  });

  test('cerrado el turno, la zona admite uno nuevo (entrega de turno)', async () => {
    await inRollback(async (client) => {
      await openShift(client);
    });
  });

  test('una caja no se puede borrar', async () => {
    await inRollback(async (client) => {
      await openShift(client);
      await expect(client.query('DELETE FROM cash_registers')).rejects.toThrow(/no se borran/);
    });
  });
});
