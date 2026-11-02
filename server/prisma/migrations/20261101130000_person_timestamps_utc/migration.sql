-- Correction for 20261101100000_person_registry: its backfill set "Person"."updatedAt" with CURRENT_TIMESTAMP, which
-- on a database server outside UTC is local wall-clock time in a column the application reads as UTC. Those rows
-- looked "changed in the future" to the incremental people feed (updatedSince). Brings any such row back to now (UTC).
-- No-op on a UTC server. Only "updatedAt" of person rows ahead of UTC is touched. No rollback needed.
UPDATE "Person" SET "updatedAt" = (now() AT TIME ZONE 'utc') WHERE "updatedAt" > (now() AT TIME ZONE 'utc');
