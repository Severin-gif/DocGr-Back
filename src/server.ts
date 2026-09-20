import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { allowedOrigins, config, legalCoreUrl } from "./config.js";
import { buildUpstreamUrl, isAllowedDocGridRequest, readBearer } from "./proxy-policy.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({
  credentials: false,
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
  exposedHeaders: ["X-Request-ID"],
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(Object.assign(new Error("Origin is not allowed"), { status: 403 }));
  },
}));
app.use(express.json({ limit: "2mb", strict: true }));

function requestId(req: Request): string {
  const supplied = req.header("x-request-id");
  if (supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)) return supplied;
  return randomUUID();
}

async function readBounded(response: globalThis.Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error("Ответ legal-core превышает лимит шлюза"), { status: 502 });
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok", service: "docgrid-bff", database: "none" });
});

app.get("/ready", async (_req, res) => {
  try {
    const response = await fetch(legalCoreUrl + "/", {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(config.UPSTREAM_READY_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    await response.body?.cancel();
    if (!response.ok) return res.status(503).json({ status: "not_ready", upstreamStatus: response.status });
    return res.json({ status: "ready", upstream: "legal-core" });
  } catch {
    return res.status(503).json({ status: "not_ready", upstream: "legal-core" });
  }
});

app.use("/api/docgrid", async (req, res, next) => {
  const id = requestId(req);
  res.setHeader("X-Request-ID", id);
  res.setHeader("Cache-Control", "no-store");

  try {
    const incoming = new URL(req.originalUrl, "https://api.docgrid.ru");
    if (!isAllowedDocGridRequest(req.method, incoming.pathname, incoming.searchParams)) {
      return res.status(404).json({ error: "Маршрут DocGrid не разрешён", requestId: id });
    }

    const token = readBearer(req.header("authorization"));
    if (!token) return res.status(401).json({ error: "Требуется DocGrid access token", requestId: id });

    if (["POST", "PUT"].includes(req.method)) {
      const contentType = req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return res.status(415).json({ error: "Ожидается application/json", requestId: id });
      }
    }

    const target = buildUpstreamUrl(legalCoreUrl, req.originalUrl);
    const started = Date.now();
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        redirect: "error",
        signal: AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Request-ID": id,
        },
        body: ["POST", "PUT"].includes(req.method) ? JSON.stringify(req.body ?? {}) : undefined,
      });
    } catch (error) {
      console.warn(JSON.stringify({
        service: "docgrid-bff",
        event: "upstream.failed",
        requestId: id,
        method: req.method,
        path: incoming.pathname,
        latencyMs: Date.now() - started,
        reason: error instanceof Error ? error.name : "unknown",
      }));
      return res.status(502).json({ error: "legal-core недоступен", requestId: id });
    }

    const body = await readBounded(upstream, config.MAX_RESPONSE_BYTES);
    const contentType = upstream.headers.get("content-type") ?? "";
    const isJson = /(^|;)\s*application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(contentType);
    if (!isJson && body) {
      console.warn(JSON.stringify({
        service: "docgrid-bff",
        event: "upstream.non_json",
        requestId: id,
        upstreamStatus: upstream.status,
        method: req.method,
        path: incoming.pathname,
      }));
      return res.status(502).json({ error: "legal-core вернул неподдерживаемый ответ", requestId: id });
    }

    console.info(JSON.stringify({
      service: "docgrid-bff",
      event: "proxy.completed",
      requestId: id,
      method: req.method,
      path: incoming.pathname,
      upstreamStatus: upstream.status,
      latencyMs: Date.now() - started,
    }));

    res.status(upstream.status);
    res.type("application/json");
    if (!body) return res.end();
    return res.send(body);
  } catch (error) {
    return next(error);
  }
});

app.use((_req, res) => res.status(404).json({ error: "Маршрут не найден" }));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const known = error as { status?: number; statusCode?: number; type?: string; message?: string };
  if (known.type === "entity.too.large" || known.status === 413) {
    return res.status(413).json({ error: "Тело запроса превышает 2 МБ" });
  }
  if (known.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Некорректный JSON" });
  }
  const status = known.status && known.status >= 400 && known.status < 600 ? known.status : 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: status >= 500 ? "Внутренняя ошибка шлюза" : known.message || "Запрос отклонён" });
});

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`DocGrid BFF listening on ${config.PORT}; upstream=${legalCoreUrl}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
