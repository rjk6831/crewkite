CREATE TABLE native_processes (
  attempt_id TEXT NOT NULL REFERENCES launch_intents(attempt_id),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 2),
  phase TEXT NOT NULL CHECK (phase IN ('effective-features', 'metadata-preparation', 'app-server-task')),
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
