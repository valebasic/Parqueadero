// Panel del administrador multisede (RF26-RF33, RF44-RF46). Solo AG y AS; cada servicio limita
// los datos a las sedes del usuario (el AG todas, el AS las suyas) y responde 403 si pide otra.
const { Router } = require('express');
const { requireRole } = require('../middlewares/authorize');
const { overview } = require('../services/admin/overview.service');
const accounting = require('../services/admin/accounting.service');
const schedules = require('../services/admin/schedules.service');
const zones = require('../services/admin/zones.service');
const alerts = require('../services/admin/alerts.service');
const { compareSites } = require('../services/admin/compare.service');
const staff = require('../services/admin/staff.service');

const router = Router();
router.use(requireRole('AG', 'AS'));
const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// RF28: tablero multisede (por sede y consolidado)
router.get('/overview', async (req, res) => ok(res, await overview(req, req.query)));

// RF29: contabilidad consolidada (+ Excel)
router.get('/accounting', async (req, res) => ok(res, await accounting.accounting(req, req.query)));
router.get('/accounting/export', async (req, res) => {
  const buffer = await accounting.accountingXlsx(req, req.query);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="contabilidad_${req.query.from}_${req.query.to}.xlsx"`);
  res.send(Buffer.from(buffer));
});

// RF30: horarios programados por zona y día de la semana
router.get('/schedules', async (req, res) => ok(res, await schedules.listSchedules(req, req.query)));
router.post('/schedules', async (req, res) => ok(res, await schedules.createSchedule(req, req.body), 201));
router.patch('/schedules/:id', async (req, res) => ok(res, await schedules.updateSchedule(req, req.params.id, req.body)));

// RF31: quién está a cargo de cada zona y su historial
router.get('/zones-status', async (req, res) => ok(res, await zones.zonesStatus(req, req.query)));
router.get('/zones/:zoneId/history', async (req, res) => ok(res, await zones.zoneHistory(req, req.params.zoneId, req.query)));

// RF32: alertas configurables
router.get('/alerts', async (req, res) => ok(res, await alerts.listAlerts(req, req.query)));
router.post('/alerts/:id/attend', async (req, res) => ok(res, await alerts.resolveAlert(req, req.params.id, 'attend', req.body)));
router.post('/alerts/:id/dismiss', async (req, res) => ok(res, await alerts.resolveAlert(req, req.params.id, 'dismiss', req.body)));
router.get('/alert-settings/:siteId', async (req, res) => ok(res, await alerts.getSettings(req, req.params.siteId)));
router.put('/alert-settings/:siteId', async (req, res) => ok(res, await alerts.updateSettings(req, req.params.siteId, req.body)));

// RF33: comparativo entre sedes
router.get('/compare', async (req, res) => ok(res, await compareSites(req, req.query)));

// RF44-RF46: horas trabajadas, reporte de turnos y ajuste autorizado
router.get('/hours', async (req, res) => ok(res, await staff.workedHours(req, req.query)));
router.get('/shift-report', async (req, res) => ok(res, await staff.shiftReport(req, req.query)));
router.get('/shift-report/export', async (req, res) => {
  const buffer = await staff.shiftReportXlsx(req, req.query);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="turnos_${req.query.from}_${req.query.to}.xlsx"`);
  res.send(Buffer.from(buffer));
});
router.get('/shifts/:id/adjustments', async (req, res) => ok(res, await staff.listAdjustments(req, req.params.id)));
router.post('/shifts/:id/adjust', async (req, res) => ok(res, await staff.adjustShift(req, req.params.id, req.body)));

module.exports = router;
