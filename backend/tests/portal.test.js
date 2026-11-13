// Portal del cliente, pantalla 1: lectura del recibo del QR (sin base de datos).
const { parseReceipt } = require('../src/services/portal.service');

test('interpreta el consecutivo del recibo', () => {
  expect(parseReceipt('FA1')).toEqual({ prefix: 'FA', number: 1 });
  expect(parseReceipt(' fm0012 ')).toEqual({ prefix: 'FM', number: 12 });
});

test('rechaza valores que no son un recibo', () => {
  for (const bad of [undefined, '', 'FA', '123', "FA1'; DROP TABLE entries;--", 'ABCDEFG1', 'FA-1']) {
    expect(parseReceipt(bad)).toBeNull();
  }
});
