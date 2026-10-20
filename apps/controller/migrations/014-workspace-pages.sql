CREATE INDEX entities_kind_id ON entities(kind,id);
CREATE INDEX task_project_id ON entities(json_extract(body,'$.projectId'),id)
  WHERE kind='task';

CREATE INDEX entities_task_id ON entities(kind,json_extract(body,'$.taskId'),id);
CREATE INDEX entities_run_id ON entities(kind,json_extract(body,'$.runId'),id);
