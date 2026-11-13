-- Up Migration
-- Enlaces de pago personales: el correo o SMS de aviso de mensualidad trae un enlace corto que lleva
-- directo a pagar, sin pedir placa ni código (el mensaje llegó al contacto registrado, eso ya es la
-- verificación). El token solo se guarda como hash; quien lo tenga solo puede PAGAR esa mensualidad
-- y ver lo mínimo para hacerlo (placa, vencimiento y valor).

CREATE TABLE portal_pay_links (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monthly_plan_id bigint NOT NULL REFERENCES monthly_plans (id),
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_pay_links_plan_idx ON portal_pay_links (monthly_plan_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS portal_pay_links;
