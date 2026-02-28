CREATE TABLE IF NOT EXISTS x402_payment_log (
  id UUID PRIMARY KEY,
  request_url TEXT NOT NULL CHECK (LENGTH(BTRIM(request_url)) > 0),
  request_domain TEXT NOT NULL CHECK (LENGTH(BTRIM(request_domain)) > 0),
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  status TEXT NOT NULL CHECK (
    status IN (
      'no_payment_required',
      'paid_success',
      'paid_failed',
      'blocked_domain',
      'blocked_single_limit',
      'blocked_budget',
      'no_payment_mechanism',
      'invalid_payment_requirement',
      'request_failed',
      'dry_run'
    )
  ),
  x402_version INT NULL,
  network TEXT NULL,
  max_amount_required TEXT NULL,
  required_amount_cents INT NULL CHECK (required_amount_cents IS NULL OR required_amount_cents >= 0),
  approved_amount_cents INT NULL CHECK (approved_amount_cents IS NULL OR approved_amount_cents >= 0),
  budget_before_cents INT NULL CHECK (budget_before_cents IS NULL OR budget_before_cents >= 0),
  budget_after_cents INT NULL CHECK (budget_after_cents IS NULL OR budget_after_cents >= 0),
  payment_header_source TEXT NULL CHECK (payment_header_source IS NULL OR payment_header_source IN ('request', 'env_static')),
  http_status INT NULL CHECK (http_status IS NULL OR (http_status >= 100 AND http_status < 600)),
  error_message TEXT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_x402_payment_log_created_at
  ON x402_payment_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x402_payment_log_status
  ON x402_payment_log (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x402_payment_log_domain
  ON x402_payment_log (request_domain, created_at DESC);
