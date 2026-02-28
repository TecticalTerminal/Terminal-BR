CREATE TABLE IF NOT EXISTS agent_behavior_log (
  id UUID PRIMARY KEY,
  agent_id UUID NULL REFERENCES agent(id) ON DELETE SET NULL,
  game_id UUID NULL REFERENCES games(id) ON DELETE SET NULL,
  seq BIGINT NULL,
  action_type TEXT NULL,
  event_source TEXT NOT NULL CHECK (event_source IN ('game_action', 'lifecycle', 'market', 'system')),
  event_type TEXT NOT NULL,
  event_status TEXT NOT NULL CHECK (event_status IN ('created', 'accepted', 'applied', 'completed', 'failed', 'skipped')),
  ref_type TEXT NULL,
  ref_id TEXT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_behavior_log_created_at
  ON agent_behavior_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_behavior_log_agent_created_at
  ON agent_behavior_log (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_behavior_log_game_created_at
  ON agent_behavior_log (game_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_behavior_log_source_created_at
  ON agent_behavior_log (event_source, created_at DESC);
