CREATE TABLE agent (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'bot')),
  status TEXT NOT NULL CHECK (status IN ('active', 'dead', 'respawning')),
  wallet_id UUID NULL,
  erc8004_agent_id NUMERIC(78, 0) NULL CHECK (erc8004_agent_id IS NULL OR erc8004_agent_id >= 0),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_wallet (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL UNIQUE REFERENCES agent(id) ON DELETE CASCADE,
  custody_mode TEXT NOT NULL CHECK (custody_mode IN ('server_managed', 'external_signer')),
  address TEXT NOT NULL UNIQUE CHECK (address ~ '^0x[a-fA-F0-9]{40}$'),
  encrypted_private_key TEXT NULL,
  kms_key_id TEXT NULL,
  signer_policy_json JSONB NULL,
  last_known_nonce NUMERIC(78, 0) NULL CHECK (last_known_nonce IS NULL OR last_known_nonce >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_wallet_server_managed_requires_key
    CHECK (custody_mode <> 'server_managed' OR encrypted_private_key IS NOT NULL)
);

ALTER TABLE agent
  ADD CONSTRAINT agent_wallet_id_unique UNIQUE (wallet_id),
  ADD CONSTRAINT agent_wallet_fk FOREIGN KEY (wallet_id) REFERENCES agent_wallet(id) ON DELETE SET NULL;

CREATE TABLE agent_profile (
  agent_id UUID PRIMARY KEY REFERENCES agent(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (LENGTH(BTRIM(display_name)) > 0),
  avatar_uri TEXT NULL,
  prompt_default TEXT NOT NULL CHECK (LENGTH(BTRIM(prompt_default)) > 0),
  prompt_override TEXT NULL,
  strategy_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_version INT NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_asset_ledger (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  game_id UUID NULL REFERENCES games(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('round', 'persistent')),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('currency', 'equipment', 'material')),
  asset_id TEXT NOT NULL CHECK (LENGTH(BTRIM(asset_id)) > 0),
  delta BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'round_start',
      'loot',
      'shop_buy',
      'shop_sell',
      'round_settlement',
      'respawn_fee',
      'market_lock',
      'market_settle',
      'admin_adjust'
    )
  ),
  ref_type TEXT NULL,
  ref_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_asset_ledger_agent_created_at
  ON agent_asset_ledger (agent_id, created_at DESC);
CREATE INDEX idx_agent_asset_ledger_agent_scope_asset
  ON agent_asset_ledger (agent_id, scope, asset_type, asset_id, id);
CREATE INDEX idx_agent_asset_ledger_game_id
  ON agent_asset_ledger (game_id);

CREATE TABLE respawn_record (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  game_id UUID NULL REFERENCES games(id) ON DELETE SET NULL,
  death_seq BIGINT NULL CHECK (death_seq IS NULL OR death_seq >= 0),
  fee_amount BIGINT NOT NULL CHECK (fee_amount >= 0),
  currency_asset_id TEXT NOT NULL DEFAULT 'credits' CHECK (LENGTH(BTRIM(currency_asset_id)) > 0),
  cooldown_seconds INT NOT NULL CHECK (cooldown_seconds >= 0),
  available_at TIMESTAMPTZ NOT NULL,
  respawned_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'cooling', 'completed', 'failed', 'cancelled')),
  paid_ledger_id BIGINT NULL REFERENCES agent_asset_ledger(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uniq_respawn_record_agent_active
  ON respawn_record (agent_id)
  WHERE status IN ('pending', 'cooling');
CREATE INDEX idx_respawn_record_status
  ON respawn_record (status, available_at);
CREATE INDEX idx_respawn_record_game_id
  ON respawn_record (game_id);

CREATE TABLE market_listing (
  id UUID PRIMARY KEY,
  seller_agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL CHECK (LENGTH(BTRIM(asset_id)) > 0),
  asset_type TEXT NOT NULL CHECK (asset_type = 'equipment'),
  quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price BIGINT NOT NULL CHECK (unit_price > 0),
  fee_bps INT NOT NULL CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  status TEXT NOT NULL CHECK (status IN ('open', 'filled', 'cancelled', 'expired')),
  expires_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_market_listing_status_expires_at
  ON market_listing (status, expires_at);
CREATE INDEX idx_market_listing_seller_created_at
  ON market_listing (seller_agent_id, created_at DESC);

CREATE TABLE market_trade (
  id UUID PRIMARY KEY,
  listing_id UUID NOT NULL UNIQUE REFERENCES market_listing(id) ON DELETE RESTRICT,
  buyer_agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE RESTRICT,
  seller_agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL CHECK (LENGTH(BTRIM(asset_id)) > 0),
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price BIGINT NOT NULL CHECK (unit_price > 0),
  gross_amount BIGINT NOT NULL CHECK (gross_amount >= 0),
  fee_amount BIGINT NOT NULL CHECK (fee_amount >= 0),
  net_amount BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('settled', 'reverted')),
  tx_ref TEXT NULL,
  settled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT market_trade_formula_gross_amount_check
    CHECK (gross_amount = quantity::BIGINT * unit_price),
  CONSTRAINT market_trade_formula_net_amount_check
    CHECK (net_amount = gross_amount - fee_amount)
);

CREATE INDEX idx_market_trade_buyer_created_at
  ON market_trade (buyer_agent_id, created_at DESC);
CREATE INDEX idx_market_trade_seller_created_at
  ON market_trade (seller_agent_id, created_at DESC);
CREATE INDEX idx_market_trade_status_settled_at
  ON market_trade (status, settled_at DESC);
