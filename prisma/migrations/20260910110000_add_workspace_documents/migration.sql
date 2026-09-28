-- User-owned CODEX workspace. It is deliberately isolated from legal-corpus
-- tables such as codex_documents and codex.legal_document.
-- gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE "docgrid"."workspace_projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "docgrid"."workspace_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "path" VARCHAR(500) NOT NULL DEFAULT '/',
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_documents_version_check" CHECK ("version" > 0)
);

CREATE TABLE "docgrid"."workspace_document_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "message" VARCHAR(300) NOT NULL DEFAULT 'Сохранена редакция',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_document_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "docgrid"."workspace_change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "base_version" INTEGER NOT NULL,
    "proposed_content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_change_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_change_requests_status_check"
      CHECK ("status" IN ('OPEN', 'MERGED', 'CLOSED')),
    CONSTRAINT "workspace_change_requests_base_version_check"
      CHECK ("base_version" > 0)
);

CREATE UNIQUE INDEX "workspace_document_versions_document_version_key"
  ON "docgrid"."workspace_document_versions"("document_id", "version");
CREATE INDEX "workspace_projects_owner_updated_idx"
  ON "docgrid"."workspace_projects"("owner_id", "updated_at" DESC);
CREATE INDEX "workspace_documents_project_path_title_idx"
  ON "docgrid"."workspace_documents"("project_id", "path", "title");
CREATE INDEX "workspace_document_versions_author_idx"
  ON "docgrid"."workspace_document_versions"("author_id", "created_at" DESC);
CREATE INDEX "workspace_change_requests_project_created_idx"
  ON "docgrid"."workspace_change_requests"("project_id", "created_at" DESC);
CREATE INDEX "workspace_change_requests_author_idx"
  ON "docgrid"."workspace_change_requests"("author_id", "created_at" DESC);

ALTER TABLE "docgrid"."workspace_projects"
  ADD CONSTRAINT "workspace_projects_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "docgrid"."User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."workspace_documents"
  ADD CONSTRAINT "workspace_documents_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "docgrid"."workspace_projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."workspace_document_versions"
  ADD CONSTRAINT "workspace_document_versions_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "docgrid"."workspace_documents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."workspace_document_versions"
  ADD CONSTRAINT "workspace_document_versions_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "docgrid"."User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "docgrid"."workspace_change_requests"
  ADD CONSTRAINT "workspace_change_requests_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "docgrid"."workspace_projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."workspace_change_requests"
  ADD CONSTRAINT "workspace_change_requests_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "docgrid"."workspace_documents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."workspace_change_requests"
  ADD CONSTRAINT "workspace_change_requests_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "docgrid"."User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

