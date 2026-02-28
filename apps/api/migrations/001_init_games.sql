CREATE TYPE game_status AS ENUM ('created', 'active', 'game_over', 'archived');

CREATE TABLE games (
  id UUID PRIMARY KEY,
  status game_status NOT NULL DEFAULT 'created',
  seq BIGINT NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'online',
  state_json JSONB NOT NULL,
  winner_player_id TEXT NULL,
  final_state_hash TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE game_events (
  id BIGSERIAL PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  action_type TEXT NOT NULL,
  action_payload JSONB NOT NULL,
  state_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, seq)
);

CREATE INDEX idx_game_events_game_seq ON game_events (game_id, seq);

CREATE TABLE game_idempotency (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  client_action_id TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_id, client_action_id)
);
