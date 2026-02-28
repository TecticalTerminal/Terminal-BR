CREATE TABLE game_rounds (
  game_id UUID PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  game_id_hash TEXT NOT NULL,
  round_id NUMERIC(78, 0) NOT NULL,
  market_address TEXT NOT NULL,
  chain_id BIGINT NULL,
  open_tx_hash TEXT NULL,
  resolve_tx_hash TEXT NULL,
  winner_outcome_hash TEXT NULL,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_game_rounds_round_id ON game_rounds (round_id);
