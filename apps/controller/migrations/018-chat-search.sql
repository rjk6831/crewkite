-- Full-text search over what a person can look for in a thread: its title, the messages, the
-- titles and summaries of tool cards, and the file paths those cards named.
--
-- One row of chat_search_docs holds one searchable text and the thread it belongs to. The FTS5
-- table indexes those rows without a copy of the text. Triggers keep both in step with every
-- write to the title, the conversation and the event log, inside the transaction that made it,
-- and drop a thread's rows when its task goes. The trigram tokenizer matches any run of three or
-- more characters, so it finds a path fragment and a Thai or Japanese word the same way it finds
-- an English one, and it folds case and accents.
--
-- ref is the identity of a row inside its thread, so a text written twice is stored once. A
-- message row names its message. A tool row names its turn and call. turn_id is the turn the text
-- belongs to when the writer knew it; a user message gets its turn when a search reads it.

CREATE TABLE chat_search_docs (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('title', 'message', 'tool', 'path')),
  ref TEXT NOT NULL,
  turn_id TEXT,
  message_id TEXT,
  body TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX chat_search_docs_ref ON chat_search_docs(task_id, kind, ref);

CREATE VIRTUAL TABLE chat_search USING fts5(
  body,
  content = 'chat_search_docs',
  content_rowid = 'id',
  tokenize = 'trigram remove_diacritics 1'
);

CREATE TRIGGER chat_search_docs_insert AFTER INSERT ON chat_search_docs BEGIN
  INSERT INTO chat_search(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER chat_search_docs_delete AFTER DELETE ON chat_search_docs BEGIN
  INSERT INTO chat_search(chat_search, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER chat_search_docs_update AFTER UPDATE OF body ON chat_search_docs BEGIN
  INSERT INTO chat_search(chat_search, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO chat_search(rowid, body) VALUES (new.id, new.body);
END;

-- The title is the task's title.
CREATE TRIGGER chat_search_title_insert AFTER INSERT ON entities WHEN new.kind = 'task' BEGIN
  INSERT INTO chat_search_docs(task_id, kind, ref, body)
  VALUES (new.id, 'title', 'title', substr(coalesce(json_extract(new.body, '$.title'), ''), 1, 1024))
  ON CONFLICT(task_id, kind, ref) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
END;
CREATE TRIGGER chat_search_title_update AFTER UPDATE OF body ON entities WHEN new.kind = 'task' BEGIN
  INSERT INTO chat_search_docs(task_id, kind, ref, body)
  VALUES (new.id, 'title', 'title', substr(coalesce(json_extract(new.body, '$.title'), ''), 1, 1024))
  ON CONFLICT(task_id, kind, ref) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
END;
-- Removing a task removes everything searchable under it.
CREATE TRIGGER chat_search_task_delete AFTER DELETE ON entities WHEN old.kind = 'task' BEGIN
  DELETE FROM chat_search_docs WHERE task_id = old.id;
END;

-- Messages the person reads in the thread. The writer inserts a row and then sets its body, so the
-- trigger watches the body.
CREATE TRIGGER chat_search_message AFTER UPDATE OF body ON conversation_entries
WHEN json_extract(new.body, '$.kind') IN ('user-message', 'chat-assistant')
  AND length(trim(coalesce(json_extract(new.body, '$.text'), ''))) > 0
BEGIN
  INSERT INTO chat_search_docs(task_id, kind, ref, turn_id, message_id, body)
  VALUES (
    new.task_id, 'message', new.id, json_extract(new.body, '$.author.turnId'), new.id,
    substr(json_extract(new.body, '$.text'), 1, 100000)
  )
  ON CONFLICT(task_id, kind, ref) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
END;

-- Tool cards. A call's title and the paths in its input arrive with tool.started, and its summary
-- and the path of its diff arrive with tool.completed. Output chunks and text deltas are not
-- indexed.
CREATE TRIGGER chat_search_tool_started AFTER UPDATE OF body ON events
WHEN new.task_id IS NOT NULL
  AND json_extract(new.body, '$.type') = 'agent.event'
  AND json_extract(new.body, '$.payload.type') = 'tool.started'
BEGIN
  INSERT INTO chat_search_docs(task_id, kind, ref, turn_id, body)
  VALUES (
    new.task_id, 'tool',
    json_extract(new.body, '$.payload.turnId') || ':' || json_extract(new.body, '$.payload.callId') || ':started',
    json_extract(new.body, '$.payload.turnId'),
    substr(coalesce(json_extract(new.body, '$.payload.title'), ''), 1, 4096)
  )
  ON CONFLICT(task_id, kind, ref) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
  INSERT INTO chat_search_docs(task_id, kind, ref, turn_id, body)
  SELECT new.task_id, 'path',
    json_extract(new.body, '$.payload.turnId') || ':' || json_extract(new.body, '$.payload.callId') || ':input',
    json_extract(new.body, '$.payload.turnId'),
    substr(group_concat(named.path, char(10)), 1, 8192)
  FROM (
    SELECT json_extract(new.body, '$.payload.input.file_path') AS path
    UNION ALL SELECT json_extract(new.body, '$.payload.input.notebook_path')
    UNION ALL SELECT json_extract(new.body, '$.payload.input.path')
    UNION ALL SELECT json_extract(new.body, '$.payload.input.filePath')
    UNION ALL SELECT value FROM json_each(new.body, '$.payload.input.paths')
  ) AS named
  WHERE typeof(named.path) = 'text' AND named.path <> ''
  GROUP BY 1
  HAVING count(*) > 0
  ON CONFLICT(task_id, kind, ref) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
END;

CREATE TRIGGER chat_search_tool_completed AFTER UPDATE OF body ON events
WHEN new.task_id IS NOT NULL
  AND json_extract(new.body, '$.type') = 'agent.event'
  AND json_extract(new.body, '$.payload.type') = 'tool.completed'
BEGIN
  INSERT INTO chat_search_docs(task_id, kind, ref, turn_id, body)
  SELECT new.task_id, 'tool',
    json_extract(new.body, '$.payload.turnId') || ':' || json_extract(new.body, '$.payload.callId') || ':summary',
    json_extract(new.body, '$.payload.turnId'),
    substr(json_extract(new.body, '$.payload.summary'), 1, 4096)
  WHERE length(trim(coalesce(json_extract(new.body, '$.payload.summary'), ''))) > 0
  ON CONFLICT(task_id, kind, ref) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
  INSERT INTO chat_search_docs(task_id, kind, ref, turn_id, body)
  SELECT new.task_id, 'path',
    json_extract(new.body, '$.payload.turnId') || ':' || json_extract(new.body, '$.payload.callId') || ':diff',
    json_extract(new.body, '$.payload.turnId'),
    substr(json_extract(new.body, '$.payload.diff.path'), 1, 4096)
  WHERE length(coalesce(json_extract(new.body, '$.payload.diff.path'), '')) > 0
  ON CONFLICT(task_id, kind, ref) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
END;

-- Threads that exist before this migration. Setting a body to itself runs the same triggers a new
-- write runs, so a thread found here and a thread written later index the same way.
UPDATE entities SET body = body WHERE kind = 'task';
UPDATE conversation_entries SET body = body
  WHERE json_extract(body, '$.kind') IN ('user-message', 'chat-assistant');
UPDATE events SET body = body
  WHERE task_id IS NOT NULL
    AND json_extract(body, '$.type') = 'agent.event'
    AND json_extract(body, '$.payload.type') IN ('tool.started', 'tool.completed');
