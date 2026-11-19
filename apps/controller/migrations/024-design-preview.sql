-- The preview a project declares for its screenshot check: the command that serves it from a
-- thread's copy, the loopback address it answers on and the views to shoot. The body is the
-- matching contract record. A project with no preview runs no screenshot check.
ALTER TABLE design_systems ADD COLUMN preview TEXT CHECK (preview IS NULL OR json_valid(preview));
