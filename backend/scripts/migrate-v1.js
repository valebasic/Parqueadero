#!/usr/bin/env node
// Migración de datos de la v1.0 a la v2.0.
//
//   npm run migrate:v1 -- archivo.json --dry-run       solo informa (no guarda nada)
//   npm run migrate:v1 -- archivo.json                 importa (todo o nada)
//
// Opciones:
//   --sede=FACA        código de la sede destino (por defecto FACA)
//   --reporte=x.json   guarda además el reporte completo en JSON
//
// Código de salida: 0 = aplicada o simulación que cuadra · 2 = revertida (no cuadra) · 1 = error
const fs = require('fs');
const path = require('path');
require('../src/config/env');
const { parseExport } = require('../src/migration/v1/source');
const { runImport } = require('../src/migration/v1/importer');
const { formatReport } = require('../src/migration/v1/report');
const { closePool } = require('../src/db/pool');

function parseArgs(argv) {
  const out = { file: null, dryRun: false, siteCode: 'FACA', reportPath: null };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--sede=') || a.startsWith('--site=')) out.siteCode = a.split('=')[1].toUpperCase();
    else if (a.startsWith('--reporte=') || a.startsWith('--report=')) out.reportPath = a.split('=')[1];
    else if (!a.startsWith('--') && !out.file) out.file = a;
    else throw new Error(`Opción desconocida: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Uso: npm run migrate:v1 -- <archivo.json> [--dry-run] [--sede=FACA] [--reporte=reporte.json]');
    return 1;
  }
  const file = path.resolve(args.file);
  const parsed = parseExport(fs.readFileSync(file));
  const report = await runImport(parsed, { siteCode: args.siteCode, dryRun: args.dryRun, fileName: path.basename(file) });
  console.log(formatReport(report));
  if (args.reportPath) {
    fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReporte completo: ${path.resolve(args.reportPath)}`);
  }
  if (report.outcome === 'ROLLED_BACK_UNBALANCED' || report.outcome === 'ABORTED') return 2;
  if (report.outcome === 'DRY_RUN' && !report.balanced) return 2;
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
