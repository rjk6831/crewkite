CREATE TABLE google_usage_reader (
  family TEXT PRIMARY KEY CHECK (family = 'google'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  authority_revision INTEGER NOT NULL DEFAULT 0 CHECK (authority_revision >= 0),
  last_attempt_at TEXT,
  last_observed_at TEXT
) STRICT;

INSERT INTO google_usage_reader(family) VALUES ('google');

CREATE TABLE google_metadata_operations (
  command_id TEXT PRIMARY KEY,
  family TEXT NOT NULL DEFAULT 'google' CHECK (family = 'google'),
  kind TEXT NOT NULL CHECK (kind IN ('usage', 'acp-initialize', 'acp-authenticate', 'acp-discover')),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('intent', 'owned', 'quiescent', 'unknown')),
  pid INTEGER CHECK (pid > 0),
  process_group INTEGER CHECK (process_group > 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (
    (state IN ('intent', 'unknown') AND pid IS NULL AND process_group IS NULL AND finished_at IS NULL)
    OR (state IN ('owned', 'unknown') AND pid = process_group AND pid IS NOT NULL AND finished_at IS NULL)
    OR (state = 'quiescent' AND finished_at IS NOT NULL AND
      ((pid IS NULL AND process_group IS NULL) OR (pid = process_group AND pid IS NOT NULL)))
  )
) STRICT;

CREATE UNIQUE INDEX google_metadata_owner ON google_metadata_operations(family)
  WHERE state <> 'quiescent';
