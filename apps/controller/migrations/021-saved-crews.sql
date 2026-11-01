CREATE TABLE saved_crews (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40),
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 60),
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;

CREATE TABLE crew_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_crew TEXT NOT NULL,
  imported_at TEXT
) STRICT;
INSERT INTO crew_settings(id, default_crew, imported_at) VALUES (1, 'preset:Solo', NULL);
