-- Tables for writing rules, dependency preparation, checked acceptance, API connections, project
-- design systems and confirmed GitHub writes. Each body is the matching contract record. Every
-- table starts empty: nothing here is inferred from rows an earlier version wrote. Columns that
-- name a task or a project hold a foreign key, so removing a thread still finds every reference.

-- One row per rule the person switched. A rule with no row takes its catalogue default.
CREATE TABLE writing_rules (
  rule_id TEXT PRIMARY KEY CHECK (length(rule_id) BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE dependency_preparations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  scope TEXT NOT NULL CHECK (scope IN ('thread', 'lane', 'acceptance')),
  scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'prepared', 'stale', 'failed', 'unsupported')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, scope, scope_key)
) STRICT;

CREATE TABLE acceptance_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  state TEXT NOT NULL CHECK (state IN
    ('reserved', 'checking', 'publishing', 'published', 'refused', 'cancelled', 'unknown')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX acceptance_attempts_task ON acceptance_attempts(task_id);
-- One acceptance is active per thread. A second one is refused while the first holds the thread.
CREATE UNIQUE INDEX acceptance_attempts_active ON acceptance_attempts(task_id)
  WHERE state IN ('reserved', 'checking', 'publishing');

-- No secret is stored here. The native client keeps its own credential.
CREATE TABLE connections (
  connection_id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('openai', 'anthropic', 'google', 'local')),
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('subscription', 'api', 'local')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- The person's explicit choice of a connection for a thread or one of its roles.
CREATE TABLE connection_assignments (
  task_id TEXT NOT NULL REFERENCES entities(id),
  role TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(connection_id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role)
) STRICT;

-- The canonical design system is a file in the project. These rows record where it is, the
-- version CrewKite saved last and whether turns receive it.
CREATE TABLE design_systems (
  project_id TEXT PRIMARY KEY REFERENCES entities(id),
  path TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64 AND version_hash NOT GLOB '*[^0-9a-f]*'),
  delivery INTEGER NOT NULL CHECK (delivery IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE design_system_versions (
  project_id TEXT NOT NULL REFERENCES entities(id),
  version INTEGER NOT NULL,
  version_hash TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  saved_at TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
) STRICT;

CREATE TABLE design_findings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  project_id TEXT NOT NULL REFERENCES entities(id),
  version_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'sent', 'allowed', 'updated', 'resolved')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX design_findings_task ON design_findings(task_id, state);

-- A project with no row uses the default commit and branch policy.
CREATE TABLE repository_policies (
  project_id TEXT PRIMARY KEY REFERENCES entities(id),
  body TEXT NOT NULL CHECK (json_valid(body)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE remote_effects (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  kind TEXT NOT NULL CHECK (kind IN
    ('push', 'pr-open', 'pr-update', 'pr-ready', 'pr-draft', 'review-reply', 'rerun', 'merge')),
  state TEXT NOT NULL CHECK (state IN
    ('proposed', 'confirmed', 'sent', 'applied', 'refused', 'unknown', 'cancelled')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX remote_effects_task ON remote_effects(task_id);
-- One write of a kind is in flight per thread. An unknown one holds the slot until a read of the
-- remote settles it, so a retry cannot start a second write of that kind before then.
CREATE UNIQUE INDEX remote_effects_in_flight ON remote_effects(task_id, kind)
  WHERE state IN ('confirmed', 'sent', 'unknown');
