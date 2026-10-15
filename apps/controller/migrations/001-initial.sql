CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'task', 'run', 'attempt', 'route', 'approval', 'candidate', 'artifact', 'window')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;

CREATE TABLE project_paths (
  project_id TEXT PRIMARY KEY REFERENCES entities(id),
  path TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE receipts (
  command_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  principal TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result))
) STRICT;

CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES entities(id),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;

CREATE TABLE writer_leases (
  task_id TEXT PRIMARY KEY REFERENCES entities(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES entities(id),
  generation INTEGER NOT NULL CHECK (generation >= 0)
) STRICT;

CREATE TABLE launch_intents (
  attempt_id TEXT PRIMARY KEY REFERENCES entities(id),
  task_id TEXT NOT NULL REFERENCES entities(id),
  run_id TEXT NOT NULL REFERENCES entities(id),
  route_id TEXT NOT NULL REFERENCES entities(id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  scratch_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent', 'acknowledged', 'outcome-unknown', 'interrupted', 'stopped')),
  pid INTEGER CHECK (pid > 0),
  process_group INTEGER CHECK (process_group > 0)
) STRICT;

CREATE TABLE reservations (
  attempt_id TEXT NOT NULL REFERENCES entities(id),
  route_id TEXT NOT NULL REFERENCES entities(id),
  window_id TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('percent', 'tokens', 'requests', 'credits', 'minutes')),
  value REAL NOT NULL CHECK (value >= 0 AND value <= 1.7976931348623157e308),
  launches INTEGER NOT NULL CHECK (launches >= 0),
  minutes INTEGER NOT NULL CHECK (minutes >= 0),
  PRIMARY KEY (attempt_id, window_id)
) STRICT;

CREATE TABLE publications (
  candidate_id TEXT PRIMARY KEY REFERENCES entities(id),
  project_id TEXT NOT NULL REFERENCES entities(id),
  destination_ref TEXT NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^a-f0-9]*'),
  tree_oid TEXT NOT NULL CHECK (length(tree_oid) IN (40, 64) AND tree_oid NOT GLOB '*[^a-f0-9]*'),
  commit_oid TEXT NOT NULL CHECK (length(commit_oid) IN (40, 64) AND commit_oid NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'applied')),
  UNIQUE (project_id, destination_ref)
) STRICT;

CREATE TABLE evidence (
  candidate_id TEXT NOT NULL REFERENCES entities(id),
  kind TEXT NOT NULL CHECK (kind IN ('check', 'review')),
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^a-f0-9]*'),
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64 AND definition_hash NOT GLOB '*[^a-f0-9]*'),
  evaluator TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  PRIMARY KEY (candidate_id, kind, definition_hash, evaluator)
) STRICT;
