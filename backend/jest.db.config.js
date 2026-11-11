// Pruebas de integración contra PostgreSQL (npm run test:db).
// Usan la base de pruebas (DB_NAME_TEST o TEST_DATABASE_URL), que se recrea al empezar.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/db'],
  globalSetup: '<rootDir>/tests/db/globalSetup.js',
};
