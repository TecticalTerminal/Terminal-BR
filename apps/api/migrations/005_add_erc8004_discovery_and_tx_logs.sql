CREATE TABLE IF NOT EXISTS discovered_agents_cache (
  chain_id INT NOT NULL CHECK (chain_id > 0),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[a-fA-F0-9]{40}$'),
  token_id NUMERIC(78, 0) NOT NULL CHECK (token_id >= 0),
  agent_address TEXT NOT NULL CHECK (agent_address ~ '^0x[a-fA-F0-9]{40}$'),
  owner_address TEXT NOT NULL CHECK (owner_address ~ '^0x[a-fA-F0-9]{40}$'),
  agent_uri TEXT NOT NULL CHECK (LENGTH(BTRIM(agent_uri)) > 0),
  agent_card JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_from TEXT NOT NULL CHECK (LENGTH(BTRIM(fetched_from)) > 0),
  card_hash TEXT NOT NULL CHECK (LENGTH(BTRIM(card_hash)) > 0),
  valid_until TIMESTAMPTZ NULL,
  fetch_count INT NOT NULL DEFAULT 1 CHECK (fetch_count > 0),
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, contract_address, token_id)
);

CREATE INDEX IF NOT EXISTS idx_discovered_agents_cache_valid_until
  ON discovered_agents_cache (valid_until);
CREATE INDEX IF NOT EXISTS idx_discovered_agents_cache_agent_address
  ON discovered_agents_cache (agent_address);
CREATE INDEX IF NOT EXISTS idx_discovered_agents_cache_owner_address
  ON discovered_agents_cache (owner_address);

CREATE TABLE IF NOT EXISTS onchain_transactions (
  id UUID PRIMARY KEY,
  tx_hash TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[a-fA-F0-9]{64}$'),
  chain TEXT NOT NULL CHECK (LENGTH(BTRIM(chain)) > 0),
  operation TEXT NOT NULL CHECK (LENGTH(BTRIM(operation)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  gas_used NUMERIC(78, 0) NULL CHECK (gas_used IS NULL OR gas_used >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onchain_transactions_status
  ON onchain_transactions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onchain_transactions_chain
  ON onchain_transactions (chain, created_at DESC);

CREATE TABLE IF NOT EXISTS erc8004_sync_log (
  id UUID PRIMARY KEY,
  agent_id UUID NULL REFERENCES agent(id) ON DELETE SET NULL,
  chain TEXT NOT NULL CHECK (LENGTH(BTRIM(chain)) > 0),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[a-fA-F0-9]{40}$'),
  action TEXT NOT NULL CHECK (action IN ('register', 'update_agent_uri', 'discover', 'discover_fetch')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'skipped', 'dry_run')),
  erc8004_agent_id NUMERIC(78, 0) NULL CHECK (erc8004_agent_id IS NULL OR erc8004_agent_id >= 0),
  agent_uri TEXT NULL,
  tx_hash TEXT NULL CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[a-fA-F0-9]{64}$'),
  error_message TEXT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_erc8004_sync_log_agent
  ON erc8004_sync_log (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erc8004_sync_log_status
  ON erc8004_sync_log (status, created_at DESC);
