// Pruebas unitarias y de API que NO necesitan PostgreSQL (npm test).
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/db/'],
};
