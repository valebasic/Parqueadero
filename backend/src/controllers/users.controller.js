const usersService = require('../services/users.service');

// GET /api/users
async function listUsers(req, res) {
  res.json({ ok: true, data: await usersService.listUsers(req) });
}

// GET /api/users/:id
async function getUser(req, res) {
  res.json({ ok: true, data: await usersService.getUser(req, req.params.id) });
}

// POST /api/users
async function createUser(req, res) {
  const data = await usersService.createUser(req, req.body);
  res.status(201).json({ ok: true, data });
}

// PATCH /api/users/:id  (nombre, rol, sedes, activo/inactivo, contraseña nueva)
async function updateUser(req, res) {
  res.json({ ok: true, data: await usersService.updateUser(req, req.params.id, req.body) });
}

module.exports = { listUsers, getUser, createUser, updateUser };
