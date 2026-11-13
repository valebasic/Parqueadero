// Variables mínimas para las pruebas (si el .env ya las define, se respetan).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'secreto-solo-para-pruebas-0123456789-abcdefghij';
process.env.SEED_ADMIN_PASSWORD ||= 'ClaveSeed2026';
// Las pruebas hacen cientos de logins desde 127.0.0.1; el límite por IP se prueba aparte
process.env.LOGIN_RATE_LIMIT_MAX ||= '100000';
// URL del portal del cliente para el QR de los recibos
process.env.PORTAL_URL ||= 'https://portal.ejemplo.com';
// Las pruebas parten de zonas sin plano (el plano de Facaparking se prueba aparte con SEED_SITE_MAP=1)
process.env.SEED_SITE_MAP = '0';
