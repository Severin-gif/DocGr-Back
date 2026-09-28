-- DocGrid SSO mirror identity. Additive follow-up; do not rewrite the already-shipped GitLaw migration.
ALTER TABLE "docgrid"."User"
  ADD COLUMN "identity_provider" VARCHAR(32),
  ADD COLUMN "external_subject" VARCHAR(128),
  ADD COLUMN "local_login_disabled" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX "User_identity_provider_external_subject_key"
  ON "docgrid"."User"("identity_provider","external_subject");

ALTER TABLE "docgrid"."User"
  ADD CONSTRAINT "User_external_identity_pair_check"
  CHECK (
    ("identity_provider" IS NULL AND "external_subject" IS NULL)
    OR ("identity_provider" IS NOT NULL AND "external_subject" IS NOT NULL)
  );

