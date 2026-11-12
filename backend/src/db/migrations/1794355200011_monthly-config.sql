-- Up Migration
-- Fase 5: mensualidades completas (RF13-RF16) y configuración de la sede (RF23-RF25).

-- Mensualidades: datos del titular, espacio, autorización de datos, abono quincenal abierto,
-- pago adelantado en cola y borrado lógico.
ALTER TABLE monthly_plans
  ADD COLUMN email text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD COLUMN space_label text,                         -- espacio asignado (opcional)
  ADD COLUMN data_consent boolean NOT NULL DEFAULT false,  -- autorización de tratamiento de datos (Ley 1581)
  ADD COLUMN data_consent_at timestamptz,
  ADD COLUMN notes text,
  ADD COLUMN installment_period_start date,            -- período al que va el abono quincenal abierto
  ADD COLUMN installment_period_end date,
  ADD COLUMN installment_paid money_cop NOT NULL DEFAULT 0,
  ADD COLUMN next_period_start date,                   -- período pagado por adelantado (en cola)
  ADD COLUMN next_period_end date,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by integer REFERENCES users (id);

ALTER TABLE monthly_plans
  -- Una mensualidad registrada a mano exige la autorización de datos
  ADD CONSTRAINT monthly_plans_consent_check CHECK (origin <> 'MANUAL' OR (data_consent AND data_consent_at IS NOT NULL)),
  ADD CONSTRAINT monthly_plans_installment_check CHECK (
    (payment_status = 'PARTIAL') = (installment_period_start IS NOT NULL AND installment_period_end IS NOT NULL)
  ),
  ADD CONSTRAINT monthly_plans_next_period_check CHECK ((next_period_start IS NULL) = (next_period_end IS NULL));

CREATE INDEX monthly_plans_alive_idx ON monthly_plans (site_id, plate) WHERE deleted_at IS NULL;

-- Configuración de la sede
ALTER TABLE sites
  ADD COLUMN business_hours text,                                -- horario de atención (recibos)
  ADD COLUMN op_expense_limit money_cop NOT NULL DEFAULT 100000, -- tope de un egreso registrado por un OP
  ADD COLUMN receipt_config jsonb NOT NULL DEFAULT '{}'::jsonb;  -- campos visibles, etiquetas, mensaje

-- Down Migration
ALTER TABLE sites DROP COLUMN IF EXISTS receipt_config, DROP COLUMN IF EXISTS op_expense_limit,
  DROP COLUMN IF EXISTS business_hours;
DROP INDEX IF EXISTS monthly_plans_alive_idx;
ALTER TABLE monthly_plans
  DROP CONSTRAINT IF EXISTS monthly_plans_next_period_check,
  DROP CONSTRAINT IF EXISTS monthly_plans_installment_check,
  DROP CONSTRAINT IF EXISTS monthly_plans_consent_check,
  DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS next_period_end, DROP COLUMN IF EXISTS next_period_start,
  DROP COLUMN IF EXISTS installment_paid, DROP COLUMN IF EXISTS installment_period_end,
  DROP COLUMN IF EXISTS installment_period_start, DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS data_consent_at, DROP COLUMN IF EXISTS data_consent,
  DROP COLUMN IF EXISTS space_label, DROP COLUMN IF EXISTS email;
