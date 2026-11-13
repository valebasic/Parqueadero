// Rutas de la Fase 5: mensualidades, transacciones, inicio, reportes, configuración y respaldos.
// Todas exigen sesión (authenticate en routes/index.js); el rol se exige aquí y la sede en cada servicio.
const { Router } = require('express');
const { requireRole } = require('../middlewares/authorize');
const monthly = require('../services/monthly.service');
const movements = require('../services/movements.service');
const reports = require('../services/reports.service');
const exporter = require('../services/export.service');
const config = require('../services/config.service');
const backups = require('../services/backup.service');

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const admins = requireRole('AG', 'AS');

// --- Mensualidades (RF13-RF16): AG y AS ---
const monthlyRouter = Router();
monthlyRouter.use(admins);
monthlyRouter.get('/', async (req, res) => ok(res, await monthly.listPlans(req, req.query)));
monthlyRouter.get('/report', async (req, res) => ok(res, await monthly.report(req, req.query)));
monthlyRouter.get('/import/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_mensualidades.csv"');
  res.send(`﻿${monthly.csvTemplate()}`);
});
monthlyRouter.post('/import', async (req, res) => ok(res, await monthly.importCsv(req, req.body)));
monthlyRouter.get('/payments/:paymentId/receipt', async (req, res) =>
  ok(res, await monthly.buildMonthlyReceipt(req, Number(req.params.paymentId))));
monthlyRouter.post('/', async (req, res) => ok(res, await monthly.createPlan(req, req.body), 201));
monthlyRouter.get('/:id', async (req, res) => ok(res, await monthly.getPlan(req, req.params.id)));
monthlyRouter.patch('/:id', async (req, res) => ok(res, await monthly.updatePlan(req, req.params.id, req.body)));
monthlyRouter.delete('/:id', async (req, res) => {
  await monthly.deletePlan(req, req.params.id);
  ok(res, null);
});
monthlyRouter.post('/:id/pay', async (req, res) => ok(res, await monthly.payPlan(req, req.params.id, req.body)));
monthlyRouter.post('/:id/prepay', async (req, res) => ok(res, await monthly.prepayPlan(req, req.params.id, req.body)));
// Aviso por correo enviado a mano desde el panel principal (aparte de los automáticos)
monthlyRouter.post('/:id/remind', async (req, res) =>
  ok(res, await require('../services/notification.service').sendMonthlyReminderNow(Number.parseInt(req.params.id, 10), req)));
monthlyRouter.post('/:id/confirm-import', async (req, res) => ok(res, await monthly.confirmImported(req, req.params.id)));

// --- Transacciones (RF18): todos los roles (el OP con límites) ---
const movementsRouter = Router();
movementsRouter.get('/', async (req, res) => ok(res, await movements.listMovements(req, req.query)));
movementsRouter.post('/', async (req, res) => ok(res, await movements.createMovement(req, req.body), 201));
movementsRouter.patch('/:id', async (req, res) => ok(res, await movements.updateMovement(req, req.params.id, req.body)));
movementsRouter.delete('/:id', async (req, res) => {
  await movements.deleteMovement(req, req.params.id);
  ok(res, null);
});

// --- Inicio y reportes (RF20-RF22): AG y AS ---
const reportsRouter = Router();
reportsRouter.use(admins);
reportsRouter.get('/dashboard', async (req, res) => ok(res, await reports.dashboard(req, req.query.siteId)));
reportsRouter.get('/summary', async (req, res) => ok(res, await reports.summary(req, req.query)));
reportsRouter.get('/closures', async (req, res) => ok(res, await reports.closures(req, req.query)));
reportsRouter.get('/closures/:id', async (req, res) => ok(res, await reports.closureDetail(req, req.params.id)));
reportsRouter.get('/loyalty', async (req, res) => ok(res, await reports.loyalty(req, req.query)));
reportsRouter.get('/export', async (req, res) => {
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  const buffer = format === 'pdf' ? await exporter.toPdf(req, req.query) : await exporter.toXlsx(req, req.query);
  const name = `reporte_${req.query.from}_${req.query.to}.${format}`;
  res.setHeader(
    'Content-Type',
    format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(buffer));
});

// --- Configuración (RF23-RF24): AG y AS (sus sedes) ---
const configRouter = Router();
configRouter.use(admins);
configRouter.get('/:siteId/rates', async (req, res) => ok(res, await config.listRates(req, req.params.siteId)));
configRouter.post('/:siteId/rates', async (req, res) => ok(res, await config.createRate(req, req.params.siteId, req.body), 201));
configRouter.delete('/:siteId/rates/:rateId', async (req, res) => {
  await config.cancelScheduledRate(req, req.params.siteId, req.params.rateId);
  ok(res, null);
});
configRouter.get('/:siteId/settings', async (req, res) => ok(res, await config.getSiteSettings(req, req.params.siteId)));
configRouter.patch('/:siteId/settings', async (req, res) => ok(res, await config.updateSiteSettings(req, req.params.siteId, req.body)));

// --- Respaldos (RF25): solo AG ---
const backupsRouter = Router();
backupsRouter.use(requireRole('AG'));
backupsRouter.get('/', async (req, res) => ok(res, await backups.listBackups()));
backupsRouter.post('/', async (req, res) => ok(res, await backups.createBackup({ req, reason: 'MANUAL' }), 201));
backupsRouter.get('/:name/download', async (req, res) => {
  const file = backups.backupPath(req.params.name);
  const { recordAudit } = require('../services/audit.service');
  await recordAudit({ req, userId: req.user.id, action: 'BACKUP_DOWNLOADED', entityType: 'backup', entityId: req.params.name });
  res.download(file, req.params.name);
});

module.exports = { monthlyRouter, movementsRouter, reportsRouter, configRouter, backupsRouter };
