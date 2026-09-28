import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  rename,
  rm,
  readdir,
  stat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join, isAbsolute } from "node:path";
@Injectable()
export class DocGridBackupService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("DocGridBackup");
  private timer?: NodeJS.Timeout;
  private active = false;
  private lastSuccess: string | null = null;
  private lastError: string | null = null;
  private get directory() {
    return process.env.DOCGRID_BACKUP_DIR?.trim() || "";
  }
  status() {
    return {
      enabled: !!this.directory,
      active: this.active,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
    };
  }
  async onModuleInit() {
    if (!this.directory) return;
    if (!isAbsolute(this.directory)) {
      this.lastError = "DOCGRID_BACKUP_DIR must be absolute";
      this.log.error(this.lastError);
      return;
    }
    try {
      const saved = JSON.parse(
        await readFile(join(this.directory, "status.json"), "utf8"),
      );
      this.lastSuccess = saved.lastSuccess || null;
    } catch {}
    const run = () => void this.backup();
    this.timer = setInterval(run, 24 * 60 * 60 * 1000);
    this.timer.unref();
    if (
      !this.lastSuccess ||
      Date.now() - Date.parse(this.lastSuccess) > 24 * 60 * 60 * 1000
    )
      run();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async backup() {
    if (!this.directory || this.active) return this.status();
    this.active = true;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let temporary = "";
    try {
      if (!isAbsolute(this.directory) || !process.env.DATABASE_URL)
        throw Error("Backup configuration is incomplete");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Atomic directory lock works across replicas sharing the same mounted volume.
      lock = await open(join(this.directory, ".backup.lock"), "wx", 0o600);
      const name =
        "docgrid-" + new Date().toISOString().replace(/[:.]/g, "-") + ".dump";
      temporary = join(this.directory, name + ".partial");
      const url = new URL(process.env.DATABASE_URL);
      const env = {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || "5432",
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
        PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
      };
      const output = await open(temporary, "wx", 0o600);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            "pg_dump",
            ["--format=custom", "--no-owner", "--no-acl", "--schema=docgrid"],
            { env, stdio: ["ignore", output.fd, "ignore"] },
          );
          const timeout = setTimeout(
            () => child.kill("SIGTERM"),
            60 * 60 * 1000,
          );
          timeout.unref();
          child.once("error", () => {
            clearTimeout(timeout);
            reject(Error("pg_dump is unavailable"));
          });
          child.once("close", (code) => {
            clearTimeout(timeout);
            code === 0
              ? resolve()
              : reject(Error("pg_dump failed; previous backups retained"));
          });
        });
      } finally {
        await output.close();
      }
      if ((await stat(temporary)).size === 0) throw Error("Empty backup");
      await rename(temporary, join(this.directory, name));
      temporary = "";
      this.lastSuccess = new Date().toISOString();
      this.lastError = null;
      await writeFile(
        join(this.directory, "status.json"),
        JSON.stringify({ lastSuccess: this.lastSuccess }),
        { mode: 0o600 },
      );
      const backups = (await readdir(this.directory))
        .filter((n) => /^docgrid-.*\.dump$/.test(n))
        .sort()
        .reverse();
      for (const old of backups.slice(14)) await rm(join(this.directory, old));
      this.log.log("Database backup completed");
    } catch (e) {
      this.lastError =
        (e as NodeJS.ErrnoException).code === "EEXIST"
          ? "Backup lock exists; another replica may be running"
          : e instanceof Error
            ? e.message
            : "Backup failed";
      this.log.error(this.lastError);
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      if (lock) {
        await lock.close();
        await rm(join(this.directory, ".backup.lock"), { force: true });
      }
      this.active = false;
    }
    return this.status();
  }
}

