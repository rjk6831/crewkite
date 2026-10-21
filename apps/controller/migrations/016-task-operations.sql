CREATE TABLE task_operations (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  kind TEXT NOT NULL CHECK(kind IN ('project-command','github-read')),
  state TEXT NOT NULL CHECK(state IN ('prepared','running','stopping','succeeded','failed','cancelled','unknown')),
  revision INTEGER NOT NULL CHECK(revision>=0),
  body TEXT NOT NULL CHECK(json_valid(body) AND length(CAST(body AS BLOB))<=16384)
) STRICT;
CREATE INDEX task_operations_task_id ON task_operations(task_id,operation_id);
CREATE INDEX task_operations_state ON task_operations(state,operation_id);
