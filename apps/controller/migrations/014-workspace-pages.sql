CREATE INDEX entities_kind_id ON entities(kind,id);
CREATE INDEX task_project_id ON entities(json_extract(body,'$.projectId'),id)
  WHERE kind='task';
