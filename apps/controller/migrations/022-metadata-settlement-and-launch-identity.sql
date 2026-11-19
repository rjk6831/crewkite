-- A settled Google metadata row now says how it settled. Only a normal close may publish its
-- result. A row released because its owner was proven absent keeps its result unknown, and a late
-- callback from the old command cannot turn it into a published one.
CREATE TABLE google_metadata_operations_next (
  command_id TEXT PRIMARY KEY,
  family TEXT NOT NULL DEFAULT 'google' CHECK (family = 'google'),
  kind TEXT NOT NULL CHECK (kind IN ('usage', 'acp-initialize', 'acp-authenticate', 'acp-discover')),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('intent', 'owned', 'quiescent', 'unknown')),
  pid INTEGER CHECK (pid > 0),
  process_group INTEGER CHECK (process_group > 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- closed: the stream ended and the group was proven gone. never-spawned: no process started.
  -- owner-absent: recovery proved the recorded group gone; the result stays unknown.
  -- legacy: settled before this migration, when the kind of settlement was not kept.
  settlement TEXT CHECK (settlement IN ('closed', 'never-spawned', 'owner-absent', 'legacy')),
  CHECK (
    (state IN ('intent', 'unknown') AND pid IS NULL AND process_group IS NULL AND finished_at IS NULL)
    OR (state IN ('owned', 'unknown') AND pid = process_group AND pid IS NOT NULL AND finished_at IS NULL)
    OR (state = 'quiescent' AND finished_at IS NOT NULL AND
      ((pid IS NULL AND process_group IS NULL) OR (pid = process_group AND pid IS NOT NULL)))
  ),
  CHECK ((state = 'quiescent') = (settlement IS NOT NULL)),
  CHECK (settlement IS NOT 'never-spawned' OR process_group IS NULL),
  CHECK (settlement NOT IN ('closed', 'owner-absent') OR process_group IS NOT NULL)
) STRICT;

-- A quiescent row with no group never spawned. Every other old quiescent row may have closed
-- normally or been settled by Stop, and the old schema did not say which.
INSERT INTO google_metadata_operations_next
  (command_id, family, kind, authority_revision, state, pid, process_group,
   started_at, finished_at, settlement)
SELECT command_id, family, kind, authority_revision, state, pid, process_group,
  started_at, finished_at,
  CASE
    WHEN state <> 'quiescent' THEN NULL
    WHEN process_group IS NULL THEN 'never-spawned'
    ELSE 'legacy'
  END
FROM google_metadata_operations;

DROP TABLE google_metadata_operations;
ALTER TABLE google_metadata_operations_next RENAME TO google_metadata_operations;

CREATE UNIQUE INDEX google_metadata_owner ON google_metadata_operations(family)
  WHERE state <> 'quiescent';

-- Settlement is final. A late close cannot rewrite an owner-absent row into a closed one.
CREATE TRIGGER google_metadata_settlement_final
BEFORE UPDATE ON google_metadata_operations
WHEN OLD.state = 'quiescent'
BEGIN
  SELECT RAISE(ABORT, 'A settled Google metadata operation cannot change.');
END;

-- What the controller observed about this boot and this machine when it recorded a launch intent.
-- Both are digests keyed to this home, so no raw hardware identifier is stored. Capture failure
-- leaves a pair null. Rows from before this migration have no identity, and none is invented.
-- Nothing yet treats a changed boot as proof that an owner is gone.
CREATE TABLE launch_identity (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN
    ('google-metadata', 'native-phase', 'launch', 'chat-turn', 'operation')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  -- Sources are versioned names such as darwin-boot-session-v1. The code keeps the list, so a
  -- corrected reader needs no table rebuild.
  boot_source TEXT CHECK (length(boot_source) BETWEEN 4 AND 64 AND boot_source GLOB '[a-z]*-v[0-9]*'
    AND boot_source NOT GLOB '*[^a-z0-9-]*'),
  boot_digest TEXT CHECK (length(boot_digest) = 64 AND boot_digest NOT GLOB '*[^0-9a-f]*'),
  machine_source TEXT CHECK (length(machine_source) BETWEEN 4 AND 64
    AND machine_source GLOB '[a-z]*-v[0-9]*' AND machine_source NOT GLOB '*[^a-z0-9-]*'),
  machine_digest TEXT CHECK (length(machine_digest) = 64 AND machine_digest NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id),
  CHECK ((boot_source IS NULL) = (boot_digest IS NULL)),
  CHECK ((machine_source IS NULL) = (machine_digest IS NULL))
) STRICT;
