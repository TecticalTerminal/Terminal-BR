CREATE TABLE IF NOT EXISTS auto_trade_run (
  id UUID PRIMARY KEY,
  client_run_id TEXT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  request_json JSONB NOT NULL,
  response_json JSONB NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auto_trade_run_status_created_at
  ON auto_trade_run (status, created_at DESC);

