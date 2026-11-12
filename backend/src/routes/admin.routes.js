// Panel del administrador multisede (RF26-RF33, RF44-RF46). Solo AG y AS; cada servicio limita
// los datos a las sedes del usuario (el AG todas, el AS las suyas) y responde 403 si pide otra.
const { Router } = require('express');
const { requireRole } = require('../middlewares/authorize');
const { overview } = require('../services/admin/overview.service');
const accounting = require('../services/admin/accounting.service');
const schedules = require('../services/admin/schedules.service');

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

module.exports = router;
