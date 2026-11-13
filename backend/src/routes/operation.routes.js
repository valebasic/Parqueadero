// Rutas de operación: turnos, entradas/salidas, ventas y pendientes.
// Todas exigen sesión (authenticate en routes/index.js). La sede se valida en cada servicio (403).
const { Router } = require('express');
const { requireRole } = require('../middlewares/authorize');
const shifts = require('../services/shifts.service');
const entries = require('../services/entries.service');
const sales = require('../services/sales.service');
const pending = require('../services/pending.service');

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// --- Turnos (RF41-RF43) ---
const shiftsRouter = Router();
shiftsRouter.get('/current', async (req, res) => ok(res, await shifts.getCurrentShift(req.user.id)));
shiftsRouter.get('/open', async (req, res) => ok(res, await shifts.listOpenShifts(req, Number(req.query.siteId))));
shiftsRouter.post('/', async (req, res) => ok(res, await shifts.openShift(req, req.body), 201));
shiftsRouter.post('/:id/close', async (req, res) => ok(res, await shifts.closeShift(req, req.params.id, req.body)));
shiftsRouter.post('/:id/handover', async (req, res) => ok(res, await shifts.handoverShift(req, req.params.id, req.body)));

// --- Entradas y salidas (RF07-RF11) ---
const entriesRouter = Router();
entriesRouter.get('/lookup', async (req, res) => ok(res, await entries.lookupPlate(req, req.query.siteId, req.query.plate)));
entriesRouter.get('/open', async (req, res) => ok(res, await entries.listOpenEntries(req, req.query.siteId)));
entriesRouter.post('/', async (req, res) => ok(res, await entries.createEntry(req, req.body), 201));
entriesRouter.get('/:id/quote', async (req, res) => ok(res, await entries.quoteExit(req, req.params.id)));
entriesRouter.post('/:id/exit', async (req, res) => ok(res, await entries.registerExit(req, req.params.id, req.body)));
entriesRouter.get('/:id/receipt', async (req, res) => ok(res, await entries.getReceipt(req, req.params.id)));

// --- Ventas (RF19) ---
const salesRouter = Router();
salesRouter.get('/', async (req, res) => ok(res, await sales.listSales(req, req.query)));
salesRouter.patch('/:id/payment', async (req, res) => ok(res, await sales.changePaymentMethod(req, req.params.id, req.body)));
salesRouter.post('/:id/reprint', async (req, res) => ok(res, await sales.reprintReceipt(req, req.params.id)));

// --- Pendientes (RF12): solo administradores, como en la v1.0 ---
const pendingRouter = Router();
pendingRouter.use(requireRole('AG', 'AS'));
pendingRouter.get('/', async (req, res) => ok(res, await pending.listPending(req, req.query.siteId)));
pendingRouter.post('/confirm', async (req, res) => ok(res, await pending.confirmPending(req, req.body)));

module.exports = { shiftsRouter, entriesRouter, salesRouter, pendingRouter };
