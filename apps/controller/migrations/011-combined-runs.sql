CREATE TABLE combined_groups (
  run_id TEXT PRIMARY KEY REFERENCES entities(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES entities(id),
  preparation_id TEXT NOT NULL REFERENCES entities(id),
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('prepared','baseline','writers','assembling','awaiting-evaluation','checking','awaiting-review','reviewing','ready','paused','stopping','stopped','blocked','unknown','accepted')),
  blocker TEXT,
  paused_phase TEXT CHECK (paused_phase IS NULL OR paused_phase IN ('prepared','baseline','writers','assembling','awaiting-evaluation','checking','awaiting-review','reviewing','ready')),
  integration_ref TEXT NOT NULL UNIQUE,
  current_head TEXT CHECK (current_head IS NULL OR length(current_head) = 40),
  final_candidate_id TEXT REFERENCES entities(id),
  origin_artifact_id TEXT REFERENCES entities(id),
  integration_started_at TEXT,
  integration_finished_at TEXT,
  integration_milliseconds INTEGER NOT NULL DEFAULT 0 CHECK (integration_milliseconds BETWEEN 0 AND 60000),
  integration_active INTEGER NOT NULL DEFAULT 0 CHECK (integration_active IN (0,1)),
  CHECK ((final_candidate_id IS NULL) = (origin_artifact_id IS NULL))
) STRICT;

CREATE TABLE combined_members (
  parent_run_id TEXT NOT NULL REFERENCES combined_groups(run_id),
  ordinal INTEGER NOT NULL CHECK (ordinal IN (0,1)),
  task_id TEXT NOT NULL UNIQUE REFERENCES entities(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES entities(id),
  preparation_id TEXT NOT NULL REFERENCES entities(id),
  scope_path TEXT NOT NULL,
  scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64),
  task_hash TEXT NOT NULL CHECK (length(task_hash) = 64),
  PRIMARY KEY (parent_run_id,ordinal)
) STRICT;

CREATE TABLE combined_dispatches (
  parent_run_id TEXT NOT NULL REFERENCES combined_groups(run_id),
  phase TEXT NOT NULL CHECK (phase IN ('baseline','writer-0','writer-1','replay-0','replay-1','final-check','review')),
  maximum_minutes INTEGER NOT NULL CHECK (maximum_minutes BETWEEN 1 AND 5),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','running','passed','failed','stopped','unknown')),
  attempt_id TEXT UNIQUE REFERENCES entities(id),
  candidate_id TEXT REFERENCES entities(id),
  check_artifact_id TEXT REFERENCES entities(id),
  definition_hash TEXT CHECK (definition_hash IS NULL OR length(definition_hash) = 64),
  PRIMARY KEY (parent_run_id,phase),
  CHECK ((state = 'reserved') = (attempt_id IS NULL))
) STRICT;

CREATE TABLE combined_ref_intents (
  parent_run_id TEXT NOT NULL REFERENCES combined_groups(run_id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  operation TEXT NOT NULL,
  expected_old TEXT CHECK (expected_old IS NULL OR length(expected_old) = 40),
  expected_new TEXT CHECK (expected_new IS NULL OR length(expected_new) = 40),
  candidate_id TEXT REFERENCES entities(id),
  check_artifact_id TEXT REFERENCES entities(id),
  state TEXT NOT NULL CHECK (state IN ('prepared','applied','unknown')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  intent_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (parent_run_id,generation,operation)
) STRICT;
