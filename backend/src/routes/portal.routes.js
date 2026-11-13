// Rutas PÚBLICAS del portal del cliente (sin sesión de empleados).
// Se montan antes de `authenticate` en routes/index.js; por eso llevan su propio límite por IP.
const { Router } = require('express');
const { createRateLimiter } = require('../middlewares/rateLimit');
const portal = require('../services/portal.service');

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

const portalLimiter = createRateLimiter({
  limit: Number.parseInt(process.env.PORTAL_RATE_LIMIT_MAX, 10) || 60,
  windowMs: (Number.parseInt(process.env.PORTAL_RATE_LIMIT_WINDOW_MIN, 10) || 15) * 60 * 1000,
  message: 'Demasiadas consultas desde esta conexión.',
});
// Crear pagos es más delicado: tope más bajo
const payLimiter = createRateLimiter({
  limit: Number.parseInt(process.env.PORTAL_PAY_RATE_LIMIT_MAX, 10) || 15,
  windowMs: 15 * 60 * 1000,
  message: 'Demasiados intentos de pago desde esta conexión.',
});

const router = Router();

// Webhook de Wompi: lo llama el servidor de Wompi (no un navegador); la firma del evento es la
// autenticación, así que va sin el límite por IP de los clientes.
router.post('/wompi/webhook', async (req, res) => ok(res, await portal.handleWebhook(req.body, req)));

router.use(portalLimiter);

// --- Pantalla 3: consulta por placa ---
// Dos límites: por conexión y por placa (frena a quien rota de IP para adivinar códigos)
const { normalizePlate } = require('../lib/plates');
const HttpError = require('../middlewares/httpError');
const lookup = require('../services/portalLookup.service');
const lookupIpLimiter = createRateLimiter({
  limit: Number.parseInt(process.env.PORTAL_LOOKUP_IP_LIMIT, 10) || 20,
  windowMs: 15 * 60 * 1000,
  message: 'Demasiados intentos desde esta conexión.',
});
const lookupPlateLimiter = createRateLimiter({
  limit: Number.parseInt(process.env.PORTAL_LOOKUP_PLATE_LIMIT, 10) || 12,
  windowMs: 15 * 60 * 1000,
  message: 'Demasiados intentos con esta placa.',
  keyGenerator: (req) => `plate:${normalizePlate(req.body?.placa)}`,
});
const lookupLimits = [lookupIpLimiter, lookupPlateLimiter];

router.post('/consulta/tiquete', lookupLimits, async (req, res) =>
  ok(res, await lookup.findByTicket(req.body?.placa, req.body?.recibo)));
router.post('/consulta/codigo', lookupLimits, async (req, res) => ok(res, await lookup.requestCode(req.body?.placa, req.body?.canal)));
router.post('/consulta/verificar', lookupLimits, async (req, res) =>
  ok(res, await lookup.verifyCode(req.body?.placa, req.body?.codigo)));

// Sesión del portal (token propio, no el de empleados) del titular que verificó su código
function portalSession(req) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  try {
    if (scheme !== 'Bearer' || !token) throw new Error('sin token');
    return lookup.verifyPortalToken(token);
  } catch {
    throw new HttpError(401, 'Su consulta venció. Verifique su código de nuevo.', { code: 'PORTAL_SESSION_EXPIRED' });
  }
}

// Vista de la mensualidad
router.get('/mensualidad', async (req, res) => ok(res, await lookup.getMonthlyView(portalSession(req).planId)));

// Pagar o renovar la mensualidad en línea (Wompi o simulado)
const monthlyPay = require('../services/portalMonthly.service');
router.post('/mensualidad/pagos', payLimiter, async (req, res) =>
  ok(res, await monthlyPay.createPlanPayment(portalSession(req).planId), 201));
router.post('/mensualidad/pagos/:reference/simular', async (req, res) =>
  ok(res, await monthlyPay.simulatePlanPayment(req.params.reference, req.body?.resultado, portalSession(req).planId, req)));

// Enlace de pago personal (correo/SMS de aviso): lleva directo a pagar, sin placa ni código.
// El token es la credencial y solo permite pagar esa mensualidad y ver lo mínimo para hacerlo.
const { resolvePayLink } = require('../services/payLink.service');
const payLinkLimiter = createRateLimiter({
  limit: 30, windowMs: 15 * 60 * 1000, message: 'Demasiados intentos desde esta conexión.',
});
async function payLinkPlan(req) {
  const planId = await resolvePayLink(req.params.token);
  if (!planId) {
    throw new HttpError(404, 'Este enlace no es válido o ya venció. Pida un aviso nuevo o acérquese al parqueadero.', { code: 'PAY_LINK_INVALID' });
  }
  return planId;
}
router.get('/pagar/:token', payLinkLimiter, async (req, res) => ok(res, await monthlyPay.payLinkView(await payLinkPlan(req))));
router.post('/pagar/:token/pago', payLinkLimiter, payLimiter, async (req, res) =>
  ok(res, await monthlyPay.createPlanPayment(await payLinkPlan(req), { backPath: `/pagar/${req.params.token}` }), 201));
router.post('/pagar/:token/pago/:reference/simular', payLinkLimiter, async (req, res) =>
  ok(res, await monthlyPay.simulatePlanPayment(req.params.reference, req.body?.resultado, await payLinkPlan(req), req)));

// Pantalla 1: estancia a partir del QR del tiquete (?sede=FACA&recibo=FA1)
router.get('/recibo', async (req, res) => ok(res, await portal.getStay(req.query.sede, req.query.recibo)));

// Pantalla 2: pago
router.post('/pagos', payLimiter, async (req, res) =>
  ok(res, await portal.createPayment(req.body?.sede, req.body?.recibo, req.body?.email), 201));
router.get('/pagos/:reference', async (req, res) =>
  ok(res, await portal.getPayment(req.params.reference, req.query.id, req)));
router.post('/pagos/:reference/simular', async (req, res) =>
  ok(res, await portal.simulatePayment(req.params.reference, req.body?.resultado, req)));

module.exports = router;
