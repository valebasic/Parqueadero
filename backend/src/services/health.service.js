// Estado de la API. En fases siguientes puede incluir el chequeo de la base de datos.
function getHealth() {
  return { ok: true };
}

module.exports = { getHealth };
