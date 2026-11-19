-- Tables for recipes, their schedules, their runs and what each slice step produced. Each body is
-- the matching contract record. Every table starts empty: nothing here is inferred from rows an
-- earlier version wrote.

-- The folder a project keeps its recipe files in. A project with no row has not picked one.
CREATE TABLE recipe_folders (
  project_id TEXT PRIMARY KEY REFERENCES entities(id),
  path TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- The canonical recipe is a file in the project. These rows record where it is and the version
-- CrewKite saved last. Only a recorded version runs.
CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES entities(id),
  path TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64 AND version_hash NOT GLOB '*[^0-9a-f]*'),
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, path)
) STRICT;

CREATE TABLE recipe_versions (
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64 AND version_hash NOT GLOB '*[^0-9a-f]*'),
  body TEXT NOT NULL CHECK (json_valid(body)),
  saved_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, version)
) STRICT;

-- One schedule per recipe whose saved version has a trigger. The body holds the armed version,
-- the counts, the note and what each check resolved to when the person saved it, which is their
-- approval for scheduled runs. next_at is a column so startup finds what is due without reading
-- every body.
CREATE TABLE recipe_schedules (
  recipe_id TEXT PRIMARY KEY REFERENCES recipes(id),
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'stopped')),
  next_at TEXT,
  body TEXT NOT NULL CHECK (json_valid(body)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX recipe_schedules_due ON recipe_schedules(state, next_at);

-- One row per run. task_id and recipe_id hold no foreign key on purpose: a run's record outlives
-- its thread and its recipe's record, so a schedule's counts and the results stay true after the
-- person deletes the thread or forgets the recipe.
CREATE TABLE recipe_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES entities(id),
  recipe_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'schedule')),
  state TEXT NOT NULL CHECK (state IN
    ('running', 'asked', 'ready', 'accepted', 'discarded', 'no-change', 'reported', 'failed',
     'stopped')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;
CREATE INDEX recipe_runs_recipe ON recipe_runs(recipe_id, started_at);
CREATE INDEX recipe_runs_project ON recipe_runs(project_id, started_at);

-- One row per step of one attempt of a plan, with or without a recipe. anchor_turn_id is the
-- slice's builder turn for a lane step and the plan's orchestrator turn for a challenge or a
-- report, so a retried slice and a second plan on the same thread get rows of their own. task_id
-- and recipe_id hold no foreign key for the same reason as above. slice is null for a challenge
-- or a report.
CREATE TABLE slice_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES entities(id),
  task_id TEXT NOT NULL,
  anchor_turn_id TEXT NOT NULL,
  recipe_id TEXT,
  slice INTEGER CHECK (slice IS NULL OR slice BETWEEN 1 AND 8),
  step TEXT NOT NULL CHECK (step IN
    ('build', 'review', 'fix', 'merge', 'resolve', 'challenge', 'report')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (anchor_turn_id, step)
) STRICT;
CREATE INDEX slice_results_project ON slice_results(project_id, started_at);
CREATE INDEX slice_results_recipe ON slice_results(recipe_id);
CREATE INDEX slice_results_task ON slice_results(task_id);
