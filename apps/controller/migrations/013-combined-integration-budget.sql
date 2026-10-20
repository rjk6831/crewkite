ALTER TABLE combined_groups ADD COLUMN integration_maximum_minutes INTEGER NOT NULL DEFAULT 1 CHECK (integration_maximum_minutes BETWEEN 1 AND 1440);
ALTER TABLE combined_groups RENAME COLUMN integration_milliseconds TO legacy_integration_milliseconds;
ALTER TABLE combined_groups ADD COLUMN integration_milliseconds INTEGER NOT NULL DEFAULT 0 CHECK (integration_milliseconds BETWEEN 0 AND integration_maximum_minutes * 60000);
UPDATE combined_groups SET integration_milliseconds=legacy_integration_milliseconds;
ALTER TABLE combined_groups DROP COLUMN legacy_integration_milliseconds;
