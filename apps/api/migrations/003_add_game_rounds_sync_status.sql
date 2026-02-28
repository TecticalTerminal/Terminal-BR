ALTER TABLE game_rounds
  ADD COLUMN IF NOT EXISTS sync_status TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

UPDATE game_rounds
SET sync_status = CASE
  WHEN resolved_at IS NOT NULL THEN 'resolved'
  ELSE 'open'
END
WHERE sync_status IS NULL;

ALTER TABLE game_rounds
  ALTER COLUMN sync_status SET DEFAULT 'open',
  ALTER COLUMN sync_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'game_rounds_sync_status_check'
  ) THEN
    ALTER TABLE game_rounds
      ADD CONSTRAINT game_rounds_sync_status_check
      CHECK (sync_status IN ('open', 'resolved', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_game_rounds_sync_status
  ON game_rounds (sync_status);
