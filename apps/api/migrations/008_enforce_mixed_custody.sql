-- Scheme C (mixed custody) hard guard:
-- user  -> external_signer
-- bot   -> server_managed

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_wallet_external_signer_requires_no_key'
  ) THEN
    ALTER TABLE agent_wallet
      ADD CONSTRAINT agent_wallet_external_signer_requires_no_key
      CHECK (custody_mode <> 'external_signer' OR encrypted_private_key IS NULL)
      NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_agent_wallet_kind_custody()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind TEXT;
BEGIN
  SELECT kind INTO v_kind
  FROM agent
  WHERE id = NEW.agent_id;

  IF v_kind IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format('agent not found for wallet bind: %s', NEW.agent_id);
  END IF;

  IF v_kind = 'user' AND NEW.custody_mode <> 'external_signer' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'mixed custody violation: user agent wallet must be external_signer';
  END IF;

  IF v_kind = 'bot' AND NEW.custody_mode <> 'server_managed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'mixed custody violation: bot agent wallet must be server_managed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_wallet_kind_custody ON agent_wallet;
CREATE TRIGGER trg_agent_wallet_kind_custody
BEFORE INSERT OR UPDATE OF agent_id, custody_mode
ON agent_wallet
FOR EACH ROW
EXECUTE FUNCTION enforce_agent_wallet_kind_custody();

CREATE OR REPLACE FUNCTION enforce_agent_kind_wallet_custody()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode TEXT;
BEGIN
  IF NEW.kind = OLD.kind THEN
    RETURN NEW;
  END IF;

  SELECT custody_mode INTO v_mode
  FROM agent_wallet
  WHERE agent_id = NEW.id
  LIMIT 1;

  IF v_mode IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.kind = 'user' AND v_mode <> 'external_signer' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'mixed custody violation: user agent wallet must be external_signer';
  END IF;

  IF NEW.kind = 'bot' AND v_mode <> 'server_managed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'mixed custody violation: bot agent wallet must be server_managed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_kind_wallet_custody ON agent;
CREATE TRIGGER trg_agent_kind_wallet_custody
BEFORE UPDATE OF kind
ON agent
FOR EACH ROW
EXECUTE FUNCTION enforce_agent_kind_wallet_custody();
