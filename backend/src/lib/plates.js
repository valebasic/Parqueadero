// Placas: mismas reglas que mvc/validators.js de la v1.0 (normalizePlate / detectPlateType).
// El frontend tiene una copia en frontend/src/lib/plates.js; si cambia una, cambiar la otra
// (tests/plates.test.js las compara).

const PLATE_MAX_LENGTH = 7; // 6 caracteres + guion opcional, como en la v1.0

// Mayúsculas, sin espacios ni guiones: "abc-123" → "ABC123"
function normalizePlate(value) {
  return String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
}

// 'CAR' | 'MOTORCYCLE' | 'BICYCLE' | null. Formatos admitidos:
//   Carro: ABC123          Moto: ABC12D (y la histórica MTELEC/MTELE0/MTELE1)
//   Cicla: CICLA, BICI, PATIN (+ 0/1 para varias) y PTELEC/PTELE0/PTELE1
function detectVehicleType(value) {
  const p = normalizePlate(value);
  if (!p) return null;
  if (/^(CICLA|BICI|PATIN)[01]?$/.test(p) || /^PTELE[C01]$/.test(p)) return 'BICYCLE';
  if (/^[A-Z]{3}\d{2}[A-Z]$/.test(p) || /^MTELE[C01]$/.test(p)) return 'MOTORCYCLE';
  if (/^[A-Z]{3}\d{3}$/.test(p)) return 'CAR';
  return null;
}

function plateError(value) {
  const p = normalizePlate(value);
  if (!p) return 'Ingrese la placa.';
  if (!detectVehicleType(p)) {
    return 'Placa inválida. Use el formato de carro (ABC-123), de moto (ABC-12D) o la palabra CICLA.';
  }
  return null;
}

const VEHICLE_LABELS = { CAR: 'Carro', MOTORCYCLE: 'Moto', BICYCLE: 'Cicla' };

module.exports = { normalizePlate, detectVehicleType, plateError, PLATE_MAX_LENGTH, VEHICLE_LABELS };
