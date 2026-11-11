// Variables mínimas para las pruebas (si el .env ya las define, se respetan).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'secreto-solo-para-pruebas-0123456789-abcdefghij';
process.env.SEED_ADMIN_PASSWORD ||= 'ClaveSeed2026';
