-- SSO-first: a login created at the first university sign-in has no CampusCore password.
-- Additive (relaxes a constraint; existing passwords are untouched).
-- Rollback (only once no row has a NULL password): ALTER TABLE "User" ALTER COLUMN "passwordHash" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
