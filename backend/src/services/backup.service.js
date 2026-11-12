// Respaldos (RF25): pg_dump programado una vez al día y bajo demanda, con retención y descarga (AG).
//
// Configuración (.env):
//   BACKUP_DIR                 carpeta donde se guardan (por defecto backend/backups)
//   BACKUP_HOUR                hora local (0-23) del respaldo diario; vacío = sin programación
//   BACKUP_KEEP                cuántos respaldos conservar (por defecto 14)
//   PG_DUMP_PATH               ruta de pg_dump (por defecto "pg_dump", debe ser de la versión 16)
//   PG_DUMP_DOCKER_CONTAINER   si se define, se ejecuta "docker exec <contenedor> pg_dump ..." (PostgreSQL en Docker)
// Formato: personalizado de pg_dump (-Fc), se restaura con pg_restore.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const env = require('../config/env');
const HttpError = require('../middlewares/httpError');
const { recordAudit } = require('./audit.service');

const FILE_RE = /^nexo-\d{8}-\d{6}\.dump$/;

function settings() {
  return {
    dir: path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '../../backups')),
    keep: Math.max(1, Number.parseInt(process.env.BACKUP_KEEP, 10) || 14),
    hour: process.env.BACKUP_HOUR === undefined || process.env.BACKUP_HOUR === '' ? null : Number(process.env.BACKUP_HOUR),
    pgDump: process.env.PG_DUMP_PATH || 'pg_dump',
    container: process.env.PG_DUMP_DOCKER_CONTAINER || '',
  };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Ejecuta pg_dump escribiendo a `target`. La contraseña viaja por variable de entorno, no en la línea de comandos.
function runPgDump(target) {
  const cfg = settings();
  const url = new URL(env.databaseUrl);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  let command;
  let args;
  const childEnv = { ...process.env };
  if (cfg.container) {
    command = 'docker';
    // Dentro del contenedor pg_dump se conecta por el socket local (sin contraseña en la línea de comandos)
    args = ['exec', cfg.container, 'pg_dump', '-U', user, '-Fc', dbName];
  } else {
    command = cfg.pgDump;
    args = ['-h', url.hostname, '-p', url.port || '5432', '-U', user, '-Fc', dbName];
    childEnv.PGPASSWORD = decodeURIComponent(url.password);
  }
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    const child = spawn(command, args, { env: childEnv, windowsHide: true });
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(new Error(`No se pudo ejecutar ${command}: ${err.message}`)));
    child.on('close', (code) => {
      out.close(() => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump terminó con código ${code}: ${stderr.trim().slice(0, 300)}`));
      });
    });
  });
}

async function listBackups() {
  const { dir } = settings();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// Borra los más antiguos dejando solo los `keep` más recientes
async function applyRetention() {
  const { dir, keep } = settings();
  const all = await listBackups();
  for (const old of all.slice(keep)) fs.unlinkSync(path.join(dir, old.name));
}

async function createBackup({ req = null, reason = 'MANUAL' } = {}) {
  const { dir } = settings();
  fs.mkdirSync(dir, { recursive: true });
  const name = `nexo-${stamp()}.dump`;
  const target = path.join(dir, name);
  const partial = `${target}.partial`;
  try {
    await runPgDump(partial);
    fs.renameSync(partial, target);
  } catch (err) {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    await recordAudit({ req, userId: req?.user?.id ?? null, action: 'BACKUP_FAILED', entityType: 'backup', details: { reason, error: err.message } }).catch(() => {});
    throw new HttpError(500, `No se pudo crear el respaldo: ${err.message}`, { code: 'BACKUP_FAILED' });
  }
  await applyRetention();
  const size = fs.statSync(target).size;
  await recordAudit({ req, userId: req?.user?.id ?? null, action: 'BACKUP_CREATED', entityType: 'backup', entityId: name, details: { reason, size } });
  return { name, size };
}

// Ruta segura de un respaldo (sin ../ ni nombres arbitrarios)
function backupPath(name) {
  if (!FILE_RE.test(String(name))) throw new HttpError(400, 'Nombre de respaldo inválido', { code: 'VALIDATION_ERROR' });
  const file = path.join(settings().dir, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Respaldo no encontrado', { code: 'NOT_FOUND' });
  return file;
}

// Programación diaria: a BACKUP_HOUR (hora del servidor). Devuelve una función para detenerla.
function scheduleDailyBackups(logger = console) {
  const { hour } = settings();
  if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23) return () => {};
  let timer = null;
  const planNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    timer = setTimeout(async () => {
      try {
        const b = await createBackup({ reason: 'SCHEDULED' });
        logger.log(`Respaldo diario creado: ${b.name}`);
      } catch (err) {
        logger.error(`Respaldo diario falló: ${err.message}`);
      }
      planNext();
    }, next - now);
    timer.unref?.();
  };
  planNext();
  return () => clearTimeout(timer);
}

module.exports = { listBackups, createBackup, backupPath, scheduleDailyBackups, applyRetention, settings };
