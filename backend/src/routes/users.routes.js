// Usuarios: solo AG y AS (el OP recibe 403). Las reglas finas por sede están en users.service.
const { Router } = require('express');
const usersController = require('../controllers/users.controller');
const { requireRole } = require('../middlewares/authorize');

const router = Router();

router.use(requireRole('AG', 'AS'));

router.get('/', usersController.listUsers);
router.post('/', usersController.createUser);
router.get('/:id', usersController.getUser);
router.patch('/:id', usersController.updateUser);

module.exports = router;
