// Presencia en tiempo real (RF28, RF32): qué usuarios tienen la app abierta y conectada ahora.
// Se usa para el estado de conexión de cada sede: una sede está "en línea" si alguien con turno
// abierto en ella está conectado. Es por proceso (igual que bus.js).
const connections = new Map(); // userId → sockets abiertos
const lastSeen = new Map(); // userId → última vez conectado (Date)

function connected(userId) {
  connections.set(userId, (connections.get(userId) ?? 0) + 1);
  lastSeen.set(userId, new Date());
}

function disconnected(userId) {
  const n = (connections.get(userId) ?? 1) - 1;
  if (n <= 0) connections.delete(userId);
  else connections.set(userId, n);
  lastSeen.set(userId, new Date());
}

function isConnected(userId) {
  return (connections.get(userId) ?? 0) > 0;
}

function lastSeenAt(userId) {
  return isConnected(userId) ? new Date() : lastSeen.get(userId) ?? null;
}

// Solo para pruebas
function reset() {
  connections.clear();
  lastSeen.clear();
}

module.exports = { connected, disconnected, isConnected, lastSeenAt, reset };
