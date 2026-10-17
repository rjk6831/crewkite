CREATE TABLE google_acp_setup (
  profile_id TEXT PRIMARY KEY CHECK (profile_id = 'google-acp-v1'),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;

CREATE TABLE native_profile_bindings (
  attempt_id TEXT PRIMARY KEY REFERENCES launch_intents(attempt_id),
  profile_id TEXT NOT NULL CHECK (profile_id = 'google-acp-v1')
) STRICT;

CREATE TABLE native_processes_next (
  attempt_id TEXT NOT NULL REFERENCES launch_intents(attempt_id),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 2),
  phase TEXT NOT NULL CHECK (phase IN ('effective-features', 'metadata-preparation', 'app-server-task', 'auth-status', 'native-task', 'google-config', 'google-acp-task')),
  state TEXT NOT NULL CHECK (state IN ('intent', 'owned', 'quiescent')),
  pid INTEGER CHECK (pid > 0),
  process_group INTEGER CHECK (process_group > 0),
  intent_at TEXT NOT NULL,
  quiescent_at TEXT,
  PRIMARY KEY (attempt_id, sequence),
  UNIQUE (attempt_id, phase),
  CHECK (
    (state = 'intent' AND pid IS NULL AND process_group IS NULL AND quiescent_at IS NULL)
    OR (state = 'owned' AND pid = process_group AND pid IS NOT NULL AND process_group IS NOT NULL AND quiescent_at IS NULL)
    OR (state = 'quiescent' AND pid = process_group AND pid IS NOT NULL AND process_group IS NOT NULL AND quiescent_at IS NOT NULL)
  )
) STRICT;

INSERT INTO native_processes_next SELECT * FROM native_processes;
DROP TABLE native_processes;
ALTER TABLE native_processes_next RENAME TO native_processes;
