// Respaldos: pg_dump simulado (sin base real). Comprueba archivo, retención, nombres seguros y que la
// contraseña no viaje en la línea de comandos.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-backups-'));
process.env.BACKUP_DIR = dir;
process.env.BACKUP_KEEP = '2';
process.env.TEST_DATABASE_URL = 'postgres://nexo:secreta%40123@db.local:5433/nexo';

const mockCalls = [];
let mockExitCode = 0;
jest.mock('child_process', () => ({
  spawn: (command, args, options) => {
    mockCalls.push({ command, args, options });
    const child = new (require('events').EventEmitter)();
    child.stdout = require('stream').Readable.from([Buffer.from('PGDMP-contenido')]);
    child.stderr = new (require('events').EventEmitter)();
    child.stdout.on('end', () => setImmediate(() => child.emit('close', mockExitCode)));
    return child;
  },
}));
jest.mock('../src/services/audit.service', () => ({ recordAudit: jest.fn(async () => {}) }));

const backups = require('../src/services/backup.service');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('crea el respaldo con pg_dump -Fc y la contraseña solo en PGPASSWORD', async () => {
  const b = await backups.createBackup({ reason: 'MANUAL' });
  expect(b.name).toMatch(/^nexo-\d{8}-\d{6}\.dump$/);
  expect(fs.readFileSync(path.join(dir, b.name), 'utf8')).toBe('PGDMP-contenido');
  const call = mockCalls[0];
  expect(call.command).toBe('pg_dump');
  expect(call.args).toEqual(['-h', 'db.local', '-p', '5433', '-U', 'nexo', '-Fc', 'nexo']);
  expect(call.args.join(' ')).not.toMatch(/secreta/);
  expect(call.options.env.PGPASSWORD).toBe('secreta@123');
});

test('retención: conserva solo los BACKUP_KEEP más recientes', async () => {
  fs.writeFileSync(path.join(dir, 'nexo-20200101-000000.dump'), 'viejo');
  fs.writeFileSync(path.join(dir, 'nexo-20200102-000000.dump'), 'viejo');
  await backups.applyRetention();
  const names = (await backups.listBackups()).map((b) => b.name);
  expect(names).toHaveLength(2);
  expect(names).not.toContain('nexo-20200101-000000.dump');
});

test('si pg_dump falla no queda un archivo a medias', async () => {
  mockExitCode = 1;
  const before = fs.readdirSync(dir).length;
  await expect(backups.createBackup()).rejects.toMatchObject({ code: 'BACKUP_FAILED' });
  expect(fs.readdirSync(dir).length).toBe(before);
  mockExitCode = 0;
});

test('la descarga solo acepta nombres de respaldo válidos', () => {
  expect(() => backups.backupPath('../.env')).toThrow(/inválido/);
  expect(() => backups.backupPath('nexo-20990101-000000.dump')).toThrow(/no encontrado/);
});

test('con PG_DUMP_DOCKER_CONTAINER usa docker exec, sin contraseña en la línea de comandos', async () => {
  process.env.PG_DUMP_DOCKER_CONTAINER = 'nexo-postgres';
  await backups.createBackup();
  const call = mockCalls[mockCalls.length - 1];
  expect(call.command).toBe('docker');
  expect(call.args).toEqual(['exec', 'nexo-postgres', 'pg_dump', '-U', 'nexo', '-Fc', 'nexo']);
  delete process.env.PG_DUMP_DOCKER_CONTAINER;
});

