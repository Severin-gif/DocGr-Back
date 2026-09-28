import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocGridBackupService } from "./docgrid-backup.service";
describe("backup scheduling boundary (pg_dump fixture)", () => {
  let dir: string;
  const old = { ...process.env };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "docgrid-backup-"));
    await mkdir(join(dir, "bin"));
    process.env.PATH = join(dir, "bin") + ":" + old.PATH;
    process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
    process.env.DOCGRID_BACKUP_DIR = join(dir, "copies");
  });
  afterEach(async () => {
    process.env = { ...old };
    await rm(dir, { recursive: true, force: true });
  });
  async function dump(script: string) {
    await writeFile(join(dir, "bin", "pg_dump"), "#!/bin/sh\n" + script, {
      mode: 0o700,
    });
  }
  it("publishes completed dump atomically with status", async () => {
    await dump("printf snapshot");
    const service = new DocGridBackupService();
    const status = await service.backup();
    expect(status.lastError).toBeNull();
    expect(status.lastSuccess).toBeTruthy();
    const names = await readdir(process.env.DOCGRID_BACKUP_DIR!);
    expect(names.filter((n) => n.endsWith(".dump"))).toHaveLength(1);
    expect(
      names.some((n) => n.endsWith(".partial") || n.endsWith(".lock")),
    ).toBe(false);
    expect(
      JSON.parse(
        await readFile(
          join(process.env.DOCGRID_BACKUP_DIR!, "status.json"),
          "utf8",
        ),
      ).lastSuccess,
    ).toBe(status.lastSuccess);
  });
  it("retains prior backups and removes partial files when dumping fails", async () => {
    await dump("printf snapshot");
    const service = new DocGridBackupService();
    await service.backup();
    const success = service.status().lastSuccess;
    await dump("printf incomplete; exit 1");
    expect((await service.backup()).lastError).toContain("failed");
    expect(service.status().lastSuccess).toBe(success);
    const names = await readdir(process.env.DOCGRID_BACKUP_DIR!);
    expect(names.filter((n) => n.endsWith(".dump"))).toHaveLength(1);
    expect(names.some((n) => n.endsWith(".partial"))).toBe(false);
  });
  it("does not delete a lock owned by another process", async () => {
    await mkdir(process.env.DOCGRID_BACKUP_DIR!);
    const lock = join(process.env.DOCGRID_BACKUP_DIR!, ".backup.lock");
    await writeFile(lock, "other");
    await dump("printf snapshot");
    expect((await new DocGridBackupService().backup()).lastError).toContain(
      "lock",
    );
    expect(await readFile(lock, "utf8")).toBe("other");
  });
  it("is disabled without a configured persistent directory", async () => {
    delete process.env.DOCGRID_BACKUP_DIR;
    expect((await new DocGridBackupService().backup()).enabled).toBe(false);
  });
});

