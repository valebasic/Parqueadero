// Placas: copia de backend/src/lib/plates.js (mismas reglas que mvc/validators.js de la v1.0).
// Si cambia una, cambiar la otra: backend/tests/plates.test.js comprueba que coincidan.

export const PLATE_MAX_LENGTH = 7; // 6 caracteres + guion opcional, como en la v1.0

// Mayúsculas, sin espacios ni guiones: "abc-123" → "ABC123"
export function normalizePlate(value) {
  return String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
}

// 'CAR' | 'MOTORCYCLE' | 'BICYCLE' | null. Formatos admitidos:
//   Carro: ABC123          Moto: ABC12D (y la histórica MTELEC/MTELE0/MTELE1)
//   Cicla: CICLA, BICI, PATIN (+ 0/1 para varias) y PTELEC/PTELE0/PTELE1
export function detectVehicleType(value) {
  const p = normalizePlate(value);
  if (!p) return null;
  if (/^(CICLA|BICI|PATIN)[01]?$/.test(p) || /^PTELE[C01]$/.test(p)) return 'BICYCLE';
  if (/^[A-Z]{3}\d{2}[A-Z]$/.test(p) || /^MTELE[C01]$/.test(p)) return 'MOTORCYCLE';
  if (/^[A-Z]{3}\d{3}$/.test(p)) return 'CAR';
  return null;
}

export function plateError(value) {
  const p = normalizePlate(value);
  if (!p) return 'Ingrese la placa.';
  if (!detectVehicleType(p)) {
    return 'Placa inválida. Use el formato de carro (ABC-123), de moto (ABC-12D) o la palabra CICLA.';
  }
  return null;
}

export const VEHICLE_LABELS = { CAR: 'Carro', MOTORCYCLE: 'Moto', BICYCLE: 'Cicla' };
