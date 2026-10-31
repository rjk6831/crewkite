-- Hunks the person accepted in the Changes tab. A row holds only while the thread's base and the
-- copy's blob of the file match what it names; any other content change drops it.
CREATE TABLE chat_hunk_decisions (
  task_id TEXT NOT NULL REFERENCES entities(id),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  hunk TEXT NOT NULL CHECK (length(hunk) = 64),
  base TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (task_id, path, hunk)
) STRICT;
