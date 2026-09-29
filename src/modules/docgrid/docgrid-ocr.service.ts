import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaService } from "../../prisma/prisma.service";
import {
  DocGridMaterialStorageService,
  readMaterialBytes,
} from "./docgrid-material-storage.service";
import {
  combinePages,
  isOcrMaterial,
  OCR_MAX_BYTES,
  OCR_MAX_PAGES,
  OCR_MAX_TEXT,
  pageCount,
  recognizePage,
  OcrPage,
} from "./docgrid-ocr";
@Injectable()
export class DocGridOcrService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private log = new Logger("DocGridOcr");
  constructor(
    private readonly db: PrismaService,
    private readonly storage: DocGridMaterialStorageService,
  ) {}
  onModuleInit() {
    if (
      process.env.DOCGRID_OCR_ENABLED === "false" ||
      process.env.NODE_ENV === "test"
    )
      return;
    this.timer = setInterval(() => {
      if (!this.active)
        this.active = this.tick()
          .catch(() => this.log.warn("OCR worker cycle failed"))
          .finally(() => {
            this.active = undefined;
          });
    }, 5000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async enqueue() {
    // Includes existing uploads: migration/deploy backfills automatically. Originals are untouched.
    await this.db
      .$executeRaw`INSERT INTO docgrid.dg_ocr_jobs(material_id,sha256)
      SELECT id,sha256 FROM docgrid.docgrid_materials WHERE deleted_at IS NULL AND lower(title) ~ '\\.(pdf|png|jpe?g|bmp|webp)$'
      ON CONFLICT(material_id) DO NOTHING`;
  }
  async tick() {
    await this.enqueue();
    const token = randomUUID();
    const job = await this.db.$transaction(async (tx) => {
      // One OCR subprocess across all replicas, not one per HTTP request/process.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(29140001)`;
      const busy = await tx.$queryRaw<
        any[]
      >`SELECT material_id FROM docgrid.dg_ocr_jobs WHERE state='running' AND lease_until>now() LIMIT 1`;
      if (busy.length) return null;
      const rows = await tx.$queryRaw<
        any[]
      >`SELECT j.material_id,j.attempts FROM docgrid.dg_ocr_jobs j JOIN docgrid.docgrid_materials m ON m.id=j.material_id
        WHERE m.deleted_at IS NULL AND (j.state='queued' OR (j.state='running' AND j.lease_until<now())) ORDER BY j.updated_at,j.material_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
      if (!rows[0]) return null;
      const id = rows[0].material_id;
      if (rows[0].attempts >= 3) {
        await tx.$executeRaw`UPDATE docgrid.dg_ocr_jobs SET state='failed',reason='retry_limit',updated_at=now() WHERE material_id=${id}::uuid`;
        return null;
      }
      await tx.$executeRaw`UPDATE docgrid.dg_ocr_jobs SET state='running',attempts=attempts+1,lease_token=${token}::uuid,lease_until=now()+interval '5 minutes',updated_at=now() WHERE material_id=${id}::uuid`;
      return id as string;
    });
    if (job) await this.process(job, token);
  }
  private async process(id: string, token: string) {
    let directory: string | undefined;
    try {
      const rows = await this.db.$queryRaw<
        any[]
      >`SELECT id,title,storage_key,byte_size,sha256 FROM docgrid.docgrid_materials WHERE id=${id}::uuid AND deleted_at IS NULL`;
      const row = rows[0];
      if (!row) throw new Error("material_unavailable");
      if (!isOcrMaterial(row.title) || Number(row.byte_size) > OCR_MAX_BYTES)
        throw new Error("ocr_size_or_format_limit");
      if (!row.storage_key) {
        const [data] = await this.db.$queryRaw<
          any[]
        >`SELECT bytes FROM docgrid.docgrid_materials WHERE id=${id}::uuid AND deleted_at IS NULL`;
        if (!data) throw new Error("material_unavailable");
        row.bytes = data.bytes;
      }
      const bytes = await readMaterialBytes(row, this.storage);
      directory = await mkdtemp(join(tmpdir(), "docgrid-ocr-"));
      const file = join(directory, "source");
      await writeFile(file, bytes, { mode: 0o600 });
      const pdf = bytes.subarray(0, 5).toString() === "%PDF-";
      const total = await pageCount(file, pdf),
        limit = Math.min(total, OCR_MAX_PAGES);
      await this.db
        .$executeRaw`UPDATE docgrid.dg_ocr_jobs SET total_pages=${total} WHERE material_id=${id}::uuid AND lease_token=${token}::uuid`;
      const saved = await this.db.$queryRaw<
        OcrPage[]
      >`SELECT page,text,method,status FROM docgrid.dg_ocr_pages WHERE material_id=${id}::uuid ORDER BY page`;
      let characters = saved.reduce((n, p) => n + p.text.length, 0);
      for (let page = 1; page <= limit && characters < OCR_MAX_TEXT; page++) {
        if (this.stopped) {
          await this.db
            .$executeRaw`UPDATE docgrid.dg_ocr_jobs SET state='queued',attempts=GREATEST(attempts-1,0),lease_until=NULL WHERE material_id=${id}::uuid AND lease_token=${token}::uuid`;
          return;
        }
        if (saved.some((p) => p.page === page)) continue;
        const renewed = await this.db
          .$executeRaw`UPDATE docgrid.dg_ocr_jobs j SET lease_until=now()+interval '5 minutes',updated_at=now()
          WHERE material_id=${id}::uuid AND lease_token=${token}::uuid AND state='running' AND EXISTS(SELECT 1 FROM docgrid.docgrid_materials m WHERE m.id=j.material_id AND m.deleted_at IS NULL AND m.sha256=j.sha256)`;
        if (!renewed) throw new Error("material_unavailable");
        let result: OcrPage;
        try {
          result = await recognizePage(file, directory, page, pdf);
        } catch {
          result = { page, text: "", method: "ocr", status: "FAILED" };
        }
        if (characters + result.text.length > OCR_MAX_TEXT) {
          result.text = result.text.slice(0, OCR_MAX_TEXT - characters);
          result.status = "PARTIAL";
        }
        characters += result.text.length;
        await this.db
          .$executeRaw`INSERT INTO docgrid.dg_ocr_pages(material_id,page,text,method,status)
          SELECT ${id}::uuid,${page},${result.text},${result.method},${result.status} WHERE EXISTS(SELECT 1 FROM docgrid.dg_ocr_jobs WHERE material_id=${id}::uuid AND lease_token=${token}::uuid AND state='running') ON CONFLICT DO NOTHING`;
      }
      await this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          any[]
        >`SELECT m.extracted_text FROM docgrid.dg_ocr_jobs j JOIN docgrid.docgrid_materials m ON m.id=j.material_id
          WHERE j.material_id=${id}::uuid AND j.lease_token=${token}::uuid AND j.state='running' AND m.deleted_at IS NULL AND m.sha256=j.sha256 FOR UPDATE OF j,m`;
        if (!locked.length) return;
        const pages = await tx.$queryRaw<
          OcrPage[]
        >`SELECT page,text,method,status FROM docgrid.dg_ocr_pages WHERE material_id=${id}::uuid ORDER BY page`;
        const { text, ranges } = combinePages(pages),
          complete =
            pages.length === total && pages.every((p) => p.status === "READY");
        const reason =
          pages.length < total
            ? "ocr_page_or_text_limit"
            : complete
              ? "page_extraction_complete"
              : "ocr_unread_pages";
        // Failed OCR never replaces an existing extraction. A partial attempt remains visible in job status.
        const preserve =
          !complete && text.length < locked[0].extracted_text.length;
        if (!preserve)
          await tx.$executeRaw`UPDATE docgrid.docgrid_materials SET extracted_text=${text},extracted_pages=${JSON.stringify(ranges)}::jsonb,
          extraction_status=${complete ? "READY" : text ? "PARTIAL" : "UNREAD"},extraction_reason=${reason} WHERE id=${id}::uuid`;
        await tx.$executeRaw`UPDATE docgrid.dg_ocr_jobs SET state=${complete ? "done" : "partial"},reason=${preserve ? "prior_text_preserved" : reason},lease_until=NULL,updated_at=now() WHERE material_id=${id}::uuid AND lease_token=${token}::uuid`;
      });
    } catch (error) {
      const reason =
        error instanceof Error &&
        [
          "ocr_size_or_format_limit",
          "material_unavailable",
          "invalid_page_count",
        ].includes(error.message)
          ? error.message
          : "ocr_processing_failed";
      await this.db
        .$executeRaw`UPDATE docgrid.dg_ocr_jobs SET state=CASE WHEN attempts<3 AND ${reason}='ocr_processing_failed' THEN 'queued' ELSE 'failed' END,reason=${reason},lease_until=NULL,updated_at=now() WHERE material_id=${id}::uuid AND lease_token=${token}::uuid`;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
