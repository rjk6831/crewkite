CREATE TABLE local_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT;
