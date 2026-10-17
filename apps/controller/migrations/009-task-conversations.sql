CREATE TABLE conversation_entries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES entities(id),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
CREATE INDEX conversation_entries_task ON conversation_entries(task_id, sequence);

CREATE TABLE task_conversations (
  task_id TEXT PRIMARY KEY REFERENCES entities(id),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;

CREATE TABLE run_purposes (
  run_id TEXT PRIMARY KEY REFERENCES entities(id),
  task_id TEXT NOT NULL REFERENCES entities(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('conversation', 'execution')),
  parent_run_id TEXT REFERENCES entities(id)
) STRICT;
INSERT INTO run_purposes(run_id, task_id, purpose)
  SELECT id, json_extract(body, '$.taskId'), 'execution' FROM entities WHERE kind='run';
