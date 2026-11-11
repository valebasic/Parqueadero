// Pruebas de integración contra PostgreSQL (npm run test:db).
// Usan la base de pruebas (DB_NAME_TEST o TEST_DATABASE_URL); cada archivo la recrea al empezar.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/db'],
  testMatch: ['**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  // bcrypt con costo 12 tarda ~0,25 s por operación
  testTimeout: 30000,
};
