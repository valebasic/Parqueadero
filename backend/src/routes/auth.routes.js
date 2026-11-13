const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const authenticate = require('../middlewares/authenticate');
const { loginRateLimiter } = require('../middlewares/rateLimit');

const router = Router();

// Públicas: login (con límite por IP) y las que trabajan con la cookie de sesión
router.post('/login', loginRateLimiter, authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

// Con sesión
router.get('/me', authenticate, authController.me);
router.put('/password', authenticate, authController.changePassword);

module.exports = router;
