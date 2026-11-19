-- The process group a remote write runs in, kept beside its record. A read of the remote that
-- finds nothing settles the write only once that process is proven gone. Null: no process of the
-- write runs, because none started or the controller saw it end. 0: a process was being started
-- and its group was never recorded, so CrewKite cannot prove it gone.
ALTER TABLE remote_effects ADD COLUMN process_group INTEGER
  CHECK (process_group IS NULL OR process_group >= 0);
