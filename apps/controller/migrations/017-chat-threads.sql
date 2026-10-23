CREATE TABLE chat_threads (
  task_id TEXT PRIMARY KEY REFERENCES entities(id),
  body TEXT NOT NULL CHECK (json_valid(body)),
  handoff TEXT CHECK (handoff IS NULL OR json_valid(handoff))
) STRICT;

CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES entities(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
CREATE UNIQUE INDEX chat_turns_task ON chat_turns(task_id, sequence);
