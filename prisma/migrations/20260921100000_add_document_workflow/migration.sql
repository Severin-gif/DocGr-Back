-- Two-stage legal document workflow. A task can exist before confirmation;
-- a document/version cannot: application code creates them only after confirm.
CREATE TYPE "docgrid"."DocumentTaskOperation" AS ENUM ('CREATE', 'REVIEW', 'EDIT');
CREATE TYPE "docgrid"."DocumentTaskStatus" AS ENUM (
  'ANALYZING', 'AWAITING_CONFIRMATION', 'QUEUED', 'GENERATING',
  'CONVERTING', 'READY', 'FAILED', 'CANCELLED'
);
CREATE TYPE "docgrid"."DocumentVersionStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

CREATE TABLE "docgrid"."prepared_legal_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" TEXT NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "current_version" INTEGER NOT NULL DEFAULT 0,
  "next_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prepared_legal_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prepared_legal_documents_version_check" CHECK ("current_version" >= 0 AND "next_version" >= 1)
);

CREATE TABLE "docgrid"."document_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" TEXT NOT NULL,
  "document_id" UUID,
  "operation" "docgrid"."DocumentTaskOperation" NOT NULL,
  "status" "docgrid"."DocumentTaskStatus" NOT NULL DEFAULT 'ANALYZING',
  "request" TEXT NOT NULL,
  "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "plan" JSONB,
  "plan_revision" INTEGER NOT NULL DEFAULT 0,
  "base_version" INTEGER,
  "confirmation_comment" TEXT,
  "result_version" INTEGER,
  "failure_code" VARCHAR(80),
  "failure_message" VARCHAR(500),
  "confirmed_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_tasks_plan_revision_check" CHECK ("plan_revision" >= 0)
);

CREATE TABLE "docgrid"."document_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "docgrid"."DocumentVersionStatus" NOT NULL DEFAULT 'GENERATING',
  "title" VARCHAR(240) NOT NULL,
  "structured_content" JSONB NOT NULL,
  "plain_text" TEXT NOT NULL,
  "source_version_id" UUID,
  "change_request" TEXT,
  "docx_object_key" VARCHAR(1000),
  "pdf_object_key" VARCHAR(1000),
  "docx_size" INTEGER,
  "pdf_size" INTEGER,
  "checksum" VARCHAR(64),
  "error_message" VARCHAR(500),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ready_at" TIMESTAMPTZ(6),
  CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "document_versions_files_ready_check" CHECK (
    "status" <> 'READY' OR ("docx_object_key" IS NOT NULL AND "pdf_object_key" IS NOT NULL AND "checksum" IS NOT NULL)
  )
);

CREATE INDEX "prepared_legal_documents_owner_updated_idx"
  ON "docgrid"."prepared_legal_documents"("owner_id", "updated_at" DESC);
CREATE INDEX "document_tasks_owner_created_idx"
  ON "docgrid"."document_tasks"("owner_id", "created_at" DESC);
CREATE INDEX "document_tasks_status_updated_idx"
  ON "docgrid"."document_tasks"("status", "updated_at");
CREATE INDEX "document_tasks_document_created_idx"
  ON "docgrid"."document_tasks"("document_id", "created_at" DESC);
CREATE UNIQUE INDEX "document_versions_document_version_key"
  ON "docgrid"."document_versions"("document_id", "version");
CREATE INDEX "document_versions_document_status_version_idx"
  ON "docgrid"."document_versions"("document_id", "status", "version" DESC);
CREATE INDEX "document_versions_creator_created_idx"
  ON "docgrid"."document_versions"("created_by", "created_at" DESC);

ALTER TABLE "docgrid"."prepared_legal_documents"
  ADD CONSTRAINT "prepared_legal_documents_owner_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "docgrid"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."document_tasks"
  ADD CONSTRAINT "document_tasks_owner_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "docgrid"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."document_tasks"
  ADD CONSTRAINT "document_tasks_document_fkey"
  FOREIGN KEY ("document_id") REFERENCES "docgrid"."prepared_legal_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "docgrid"."document_versions"
  ADD CONSTRAINT "document_versions_document_fkey"
  FOREIGN KEY ("document_id") REFERENCES "docgrid"."prepared_legal_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "docgrid"."document_versions"
  ADD CONSTRAINT "document_versions_creator_fkey"
  FOREIGN KEY ("created_by") REFERENCES "docgrid"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "docgrid"."document_versions"
  ADD CONSTRAINT "document_versions_source_version_fkey"
  FOREIGN KEY ("source_version_id") REFERENCES "docgrid"."document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

