// Calendario laboral de Colombia (RF44): festivos (Ley Emiliani), jornada nocturna y reparto de horas.
const { colombianHolidays, splitWorkedTime, isoWeek, nightStartFor, easterSunday } = require('../src/lib/workhours');

const keys = (y) => [...colombianHolidays(y).keys()].sort();

describe('festivos de Colombia', () => {
  test('2026', () => {
    expect(keys(2026)).toEqual([
      '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03', '2026-05-01', '2026-05-18', '2026-06-08',
      '2026-06-15', '2026-06-29', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16',
      '2026-12-08', '2026-12-25',
    ]);
  });

  test('2025 (San Pedro y Sagrado Corazón caen el mismo lunes 30 de junio)', () => {
    expect(keys(2025)).toEqual([
      '2025-01-01', '2025-01-06', '2025-03-24', '2025-04-17', '2025-04-18', '2025-05-01', '2025-06-02', '2025-06-23',
      '2025-06-30', '2025-07-20', '2025-08-07', '2025-08-18', '2025-10-13', '2025-11-03', '2025-11-17', '2025-12-08',
      '2025-12-25',
    ]);
  });

  test('2027 y Pascua', () => {
    expect(easterSunday(2027).toISOString().slice(0, 10)).toBe('2027-03-28');
    expect(keys(2027)).toEqual(expect.arrayContaining(['2027-01-11', '2027-03-22', '2027-03-25', '2027-03-26', '2027-05-10', '2027-05-31', '2027-06-07', '2027-07-05', '2027-08-16', '2027-10-18', '2027-11-01', '2027-11-15']));
    expect(keys(2027)).toHaveLength(18);
  });
});

describe('reparto de horas trabajadas (hora de Colombia)', () => {
  // Fechas locales → UTC (+5 h)
  const at = (local) => new Date(`${local}-05:00`);

  test('turno diurno ordinario', () => {
    const r = splitWorkedTime(at('2026-11-12T07:00:00'), at('2026-11-12T15:30:00'));
    expect(r).toMatchObject({ total: 510, day: 510, night: 0, holidayDay: 0, holidayNight: 0 });
  });

  test('noche desde las 7:00 p. m. (Ley 2466 de 2025) y cruce de medianoche hacia domingo', () => {
    const r = splitWorkedTime(at('2026-11-14T18:00:00'), at('2026-11-15T08:00:00'));
    expect(r).toMatchObject({ total: 840, day: 60, night: 300, holidayNight: 360, holidayDay: 120 });
    expect(r.byDate.get('2026-11-14')).toMatchObject({ total: 360, day: 60, night: 300 });
    expect(r.byDate.get('2026-11-15')).toMatchObject({ total: 480, holidayNight: 360, holidayDay: 120 });
  });

  test('antes de la reforma la noche empezaba a las 9:00 p. m.', () => {
    expect(nightStartFor('2025-12-24')).toBe(21 * 60);
    expect(nightStartFor('2025-12-25')).toBe(19 * 60);
    const before = splitWorkedTime(at('2025-12-23T18:00:00'), at('2025-12-23T22:00:00'));
    expect(before).toMatchObject({ day: 180, night: 60 });
    const after = splitWorkedTime(at('2026-01-13T18:00:00'), at('2026-01-13T22:00:00'));
    expect(after).toMatchObject({ day: 60, night: 180 });
  });

  test('festivo entre semana (lunes 16/11/2026) y madrugada del día siguiente', () => {
    const r = splitWorkedTime(at('2026-11-16T20:00:00'), at('2026-11-17T07:00:00'));
    // Lunes festivo 20:00-24:00 = nocturna festiva; martes 00:00-06:00 nocturna ordinaria, 06:00-07:00 diurna
    expect(r).toMatchObject({ holidayNight: 240, night: 360, day: 60, total: 660 });
  });

  test('intervalos vacíos o invertidos', () => {
    expect(splitWorkedTime(at('2026-11-12T10:00:00'), at('2026-11-12T10:00:00')).total).toBe(0);
    expect(splitWorkedTime(at('2026-11-12T10:00:00'), at('2026-11-12T09:00:00')).total).toBe(0);
  });

  test('semana ISO', () => {
    expect(isoWeek('2026-11-12')).toEqual({ key: '2026-W46', start: '2026-11-09' });
    expect(isoWeek('2027-01-01')).toEqual({ key: '2026-W53', start: '2026-12-28' });
  });
});
