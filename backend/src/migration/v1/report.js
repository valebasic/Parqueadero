// Reporte de la migración en texto (consola)
const cop = (n) => `$ ${Math.round(n || 0).toLocaleString('es-CO').replace(/,/g, '.')}`;

function pad(s, n, right = false) {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function formatReport(r) {
  const lines = [];
  const title = {
    DRY_RUN: 'SIMULACIÓN (--dry-run): no se guardó nada',
    COMMITTED: 'MIGRACIÓN APLICADA',
    ROLLED_BACK_UNBALANCED: 'MIGRACIÓN REVERTIDA: los totales no cuadran',
    ABORTED: 'MIGRACIÓN CANCELADA',
  }[r.outcome] ?? r.outcome;
  lines.push('='.repeat(100), `Nexo v1.0 → v2.0 · ${title}`, '='.repeat(100));
  if (r.error) lines.push(`Error: ${r.error}`);
  if (r.site) lines.push(`Sede: ${r.site.code} · ${r.site.name}`);
  if (r.file) {
    lines.push(`Archivo: ${r.file.name ?? '—'} (sha256 ${String(r.file.sha256).slice(0, 16)}…)`);
    if (r.file.exportedAt) lines.push(`Exportado: ${r.file.exportedAt} por ${r.file.exportedBy ?? '—'} (v1 ${r.file.appVersion ?? '—'})`);
  }
  lines.push('');
  const head = [pad('Categoría', 34), pad('En archivo', 22, true), pad('Importados', 22, true), pad('Omitidos', 18, true), pad('Rechazados', 18, true), pad('Base antes → después', 34, true), '  ']
    .join(' ');
  lines.push(head, '-'.repeat(head.length));
  for (const c of Object.values(r.categories ?? {})) {
    const cell = (b, w) => pad(`${b.count} · ${cop(b.total)}`, w, true);
    const db = c.db.before && c.db.after ? `${c.db.before.count} · ${cop(c.db.before.total)} → ${c.db.after.count} · ${cop(c.db.after.total)}` : '—';
    lines.push(
      [pad(c.label, 34), cell(c.v1, 22), cell(c.imported, 22), cell(c.skipped, 18), cell(c.rejected, 18), pad(db, 34, true), c.balanced === false || c.complete === false ? '✗' : '✓'].join(' '),
    );
  }
  lines.push('');
  lines.push(r.balanced ? 'Cuadre: OK (lo que cambió en la base es exactamente lo importado)' : 'Cuadre: NO CUADRA (✗) → se revierte todo');
  if (r.users?.length) {
    lines.push('', 'Usuarios creados:');
    for (const u of r.users) lines.push(`  ${u.username} (${u.role})${u.active ? '' : ' · DESACTIVADO'}${u.username !== u.v1 ? ` · en la v1.0: ${u.v1}` : ''}`);
  }
  if (r.config?.length) {
    lines.push('', 'Configuración:');
    for (const c of r.config) lines.push(`  ${c.item}: ${JSON.stringify(c.from ?? null)} → ${JSON.stringify(c.to)}`);
  }
  if (r.rejected?.length) {
    lines.push('', `Rechazados (${r.rejected.length}):`);
    for (const x of r.rejected) lines.push(`  [${x.category}] ${x.v1Id ?? '—'}: ${x.reason}${x.amount ? ` (${cop(x.amount)})` : ''}`);
  }
  if (r.warnings?.length) {
    lines.push('', `Advertencias (${r.warnings.length}):`);
    for (const w of r.warnings) lines.push(`  [${w.category}] ${w.v1Id ?? '—'}: ${w.message}`);
  }
  const skippedNotDone = (r.skipped ?? []).filter((s) => !/^ya importad/.test(s.reason));
  const already = (r.skipped ?? []).length - skippedNotDone.length;
  if (already) lines.push('', `Ya importados en una corrida anterior: ${already} (no se duplican)`);
  if (skippedNotDone.length) {
    lines.push('', 'Omitidos:');
    for (const s of skippedNotDone) lines.push(`  [${s.category}] ${s.v1Id ?? '—'}: ${s.reason}`);
  }
  return lines.join('\n');
}

module.exports = { formatReport, cop };
