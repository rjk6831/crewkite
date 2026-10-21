CREATE TABLE activity_output (
  cursor INTEGER PRIMARY KEY REFERENCES events(cursor),
  event_id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL REFERENCES entities(id)
) STRICT;
