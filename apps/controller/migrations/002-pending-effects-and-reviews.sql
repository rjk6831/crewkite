CREATE TABLE pending_effects (
  approval_id TEXT PRIMARY KEY REFERENCES entities(id),
  task_id TEXT NOT NULL REFERENCES entities(id),
  attempt_id TEXT NOT NULL REFERENCES entities(id),
  task_revision INTEGER NOT NULL CHECK (task_revision >= 0),
  effect_hash TEXT NOT NULL CHECK (length(effect_hash) = 64 AND effect_hash NOT GLOB '*[^a-f0-9]*'),
  request TEXT NOT NULL CHECK (json_valid(request)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'applied', 'denied', 'stale', 'unknown'))
) STRICT;

CREATE TABLE review_jobs (
  attempt_id TEXT PRIMARY KEY REFERENCES entities(id),
  candidate_id TEXT NOT NULL REFERENCES entities(id),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
