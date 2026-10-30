CREATE TABLE project_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES entities(id),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX project_notes_project ON project_notes(project_id, created_at, id);
