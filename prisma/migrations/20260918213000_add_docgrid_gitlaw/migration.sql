-- DocGrid/GitLaw layer on top of the existing workspace repository.
-- Existing workspace_projects/documents/versions remain source-compatible.
CREATE TABLE "docgrid"."docgrid_branches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "kind" VARCHAR(24) NOT NULL DEFAULT 'WORK',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "docgrid_branches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "docgrid_branches_kind_check" CHECK ("kind" IN ('MAIN','WORK','AI','COUNTERPARTY'))
);

CREATE UNIQUE INDEX "docgrid_branches_project_name_key"
  ON "docgrid"."docgrid_branches"("project_id","name");
CREATE INDEX "docgrid_branches_project_updated_idx"
  ON "docgrid"."docgrid_branches"("project_id","updated_at" DESC);

CREATE TABLE "docgrid"."docgrid_commits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "parent_commit_id" UUID,
  "author_id" TEXT NOT NULL,
  "message" VARCHAR(300) NOT NULL,
  "before_content" TEXT NOT NULL,
  "after_content" TEXT NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "docgrid_commits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "docgrid_commits_branch_created_idx"
  ON "docgrid"."docgrid_commits"("branch_id","created_at" DESC);
CREATE INDEX "docgrid_commits_document_created_idx"
  ON "docgrid"."docgrid_commits"("document_id","created_at" DESC);

CREATE TABLE "docgrid"."docgrid_branch_documents" (
  "branch_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "content" TEXT NOT NULL DEFAULT '',
  "head_commit_id" UUID,
  "workspace_version" INTEGER,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "docgrid_branch_documents_pkey" PRIMARY KEY ("branch_id","document_id"),
  CONSTRAINT "docgrid_branch_documents_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "docgrid"."docgrid_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "source_branch_id" UUID NOT NULL,
  "target_branch_id" UUID NOT NULL,
  "author_id" TEXT NOT NULL,
  "merged_by" TEXT,
  "title" VARCHAR(180) NOT NULL,
  "body" VARCHAR(4000),
  "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "source_snapshot" JSONB NOT NULL,
  "target_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "merged_at" TIMESTAMPTZ(6),
  CONSTRAINT "docgrid_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "docgrid_reviews_status_check" CHECK ("status" IN ('OPEN','MERGED','CLOSED')),
  CONSTRAINT "docgrid_reviews_distinct_branches_check" CHECK ("source_branch_id" <> "target_branch_id")
);
CREATE INDEX "docgrid_reviews_project_created_idx"
  ON "docgrid"."docgrid_reviews"("project_id","created_at" DESC);

CREATE TABLE "docgrid"."docgrid_issues" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "linked_document_id" UUID,
  "author_id" TEXT NOT NULL,
  "kind" VARCHAR(16) NOT NULL DEFAULT 'ISSUE',
  "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "title" VARCHAR(180) NOT NULL,
  "body" TEXT NOT NULL DEFAULT '',
  "resolution" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ(6),
  CONSTRAINT "docgrid_issues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "docgrid_issues_kind_check" CHECK ("kind" IN ('ISSUE','DECISION')),
  CONSTRAINT "docgrid_issues_status_check" CHECK ("status" IN ('OPEN','CLOSED','DECIDED'))
);
CREATE INDEX "docgrid_issues_project_status_idx"
  ON "docgrid"."docgrid_issues"("project_id","status","updated_at" DESC);

CREATE TABLE "docgrid"."docgrid_releases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "created_by" TEXT NOT NULL,
  "tag" VARCHAR(64) NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "notes" TEXT NOT NULL DEFAULT '',
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "docgrid_releases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "docgrid_releases_project_tag_key"
  ON "docgrid"."docgrid_releases"("project_id","tag");
CREATE INDEX "docgrid_releases_project_created_idx"
  ON "docgrid"."docgrid_releases"("project_id","created_at" DESC);

CREATE TABLE "docgrid"."docgrid_events" (
  "id" BIGSERIAL NOT NULL,
  "project_id" UUID NOT NULL,
  "actor_id" TEXT NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "entity_type" VARCHAR(32) NOT NULL,
  "entity_id" UUID,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "docgrid_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "docgrid_events_project_created_idx"
  ON "docgrid"."docgrid_events"("project_id","created_at" DESC);

ALTER TABLE "docgrid"."docgrid_branches"
  ADD CONSTRAINT "docgrid_branches_project_fkey" FOREIGN KEY ("project_id")
  REFERENCES "docgrid"."workspace_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_branches"
  ADD CONSTRAINT "docgrid_branches_created_by_fkey" FOREIGN KEY ("created_by")
  REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "docgrid"."docgrid_commits"
  ADD CONSTRAINT "docgrid_commits_project_fkey" FOREIGN KEY ("project_id")
  REFERENCES "docgrid"."workspace_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_commits"
  ADD CONSTRAINT "docgrid_commits_branch_fkey" FOREIGN KEY ("branch_id")
  REFERENCES "docgrid"."docgrid_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_commits"
  ADD CONSTRAINT "docgrid_commits_document_fkey" FOREIGN KEY ("document_id")
  REFERENCES "docgrid"."workspace_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_commits"
  ADD CONSTRAINT "docgrid_commits_parent_fkey" FOREIGN KEY ("parent_commit_id")
  REFERENCES "docgrid"."docgrid_commits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_commits"
  ADD CONSTRAINT "docgrid_commits_author_fkey" FOREIGN KEY ("author_id")
  REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "docgrid"."docgrid_branch_documents"
  ADD CONSTRAINT "docgrid_branch_documents_branch_fkey" FOREIGN KEY ("branch_id")
  REFERENCES "docgrid"."docgrid_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_branch_documents"
  ADD CONSTRAINT "docgrid_branch_documents_document_fkey" FOREIGN KEY ("document_id")
  REFERENCES "docgrid"."workspace_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_branch_documents"
  ADD CONSTRAINT "docgrid_branch_documents_head_commit_fkey" FOREIGN KEY ("head_commit_id")
  REFERENCES "docgrid"."docgrid_commits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "docgrid"."docgrid_reviews"
  ADD CONSTRAINT "docgrid_reviews_project_fkey" FOREIGN KEY ("project_id")
  REFERENCES "docgrid"."workspace_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_reviews"
  ADD CONSTRAINT "docgrid_reviews_source_branch_fkey" FOREIGN KEY ("source_branch_id")
  REFERENCES "docgrid"."docgrid_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_reviews"
  ADD CONSTRAINT "docgrid_reviews_target_branch_fkey" FOREIGN KEY ("target_branch_id")
  REFERENCES "docgrid"."docgrid_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_reviews"
  ADD CONSTRAINT "docgrid_reviews_author_fkey" FOREIGN KEY ("author_id")
  REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_reviews"
  ADD CONSTRAINT "docgrid_reviews_merged_by_fkey" FOREIGN KEY ("merged_by")
  REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "docgrid"."docgrid_issues"
  ADD CONSTRAINT "docgrid_issues_project_fkey" FOREIGN KEY ("project_id")
  REFERENCES "docgrid"."workspace_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_issues"
  ADD CONSTRAINT "docgrid_issues_document_fkey" FOREIGN KEY ("linked_document_id")
  REFERENCES "docgrid"."workspace_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_issues"
  ADD CONSTRAINT "docgrid_issues_author_fkey" FOREIGN KEY ("author_id")
  REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "docgrid"."docgrid_releases"
  ADD CONSTRAINT "docgrid_releases_project_fkey" FOREIGN KEY ("project_id")
  REFERENCES "docgrid"."workspace_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_releases"
  ADD CONSTRAINT "docgrid_releases_branch_fkey" FOREIGN KEY ("branch_id")
  REFERENCES "docgrid"."docgrid_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_releases"
  ADD CONSTRAINT "docgrid_releases_created_by_fkey" FOREIGN KEY ("created_by")
  REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "docgrid"."docgrid_events"
  ADD CONSTRAINT "docgrid_events_project_fkey" FOREIGN KEY ("project_id")
  REFERENCES "docgrid"."workspace_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."docgrid_events"
  ADD CONSTRAINT "docgrid_events_actor_fkey" FOREIGN KEY ("actor_id")
  REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

