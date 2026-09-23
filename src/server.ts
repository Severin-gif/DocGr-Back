import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { allowedOrigins, config, legalCoreUrl } from "./config.js";
import { buildUpstreamUrl, readBearer, resolveDocGridRoute } from "./proxy-policy.js";
import { trustedIdentityHeaders, verifyDocGridAccessToken } from "./docgrid-identity.js";
import { buildHomeDashboard, HomeActivity, HomeRepository, parseHomeQuery } from "./home.js";

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
// Загрузка исходных материалов: multipart/form-data пробрасывается как есть,
// лимит согласован с FileInterceptor legal-core (10 МБ на файл) плюс запас на поля формы.
const MULTIPART_LIMIT = "11mb";
app.use(express.raw({ type: "multipart/form-data", limit: MULTIPART_LIMIT }));

function requestId(req: Request): string {
  const supplied = req.header("x-request-id");
  if (supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)) return supplied;
  return randomUUID();
}

async function readBoundedBytes(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}

async function readBounded(response: globalThis.Response, maxBytes: number): Promise<string> {
  return (await readBoundedBytes(response, maxBytes)).toString("utf8");
}

async function fetchUpstreamJson<T>(
  path: string,
  identity: ReturnType<typeof verifyDocGridAccessToken>,
  requestIdValue: string,
): Promise<T> {
  const target = new URL(path, legalCoreUrl.replace(/\/+$/, "") + "/");
  const response = await fetch(target, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "X-Request-ID": requestIdValue,
      ...trustedIdentityHeaders(identity),
    },
  });
  const type = response.headers.get("content-type") ?? "";
  const body = await readBounded(response, config.MAX_RESPONSE_BYTES);
  if (!response.ok) {
    throw Object.assign(new Error(`legal-core returned ${response.status}`), { status: response.status, body });
  }
  if (!/(^|;)\s*application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(type)) {
    throw Object.assign(new Error("legal-core returned non-JSON"), { status: 502 });
  }
  return JSON.parse(body || "null") as T;
}

const SAFE_DISPOSITION = /^attachment;\s*filename\*=UTF-8''[A-Za-z0-9%._-]{1,600}$/;

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

app.get("/api/docgrid/home", async (req, res, next) => {
  const id = requestId(req);
  res.setHeader("X-Request-ID", id);
  res.setHeader("Cache-Control", "no-store");

  try {
    const query = parseHomeQuery(new URL(req.originalUrl, "https://api.docgrid.ru").searchParams);
    if (!query) return res.status(400).json({ error: "Некорректные параметры Home", requestId: id });

    const token = readBearer(req.header("authorization"));
    if (!token) return res.status(401).json({ error: "Требуется DocGrid access token", requestId: id });

    let identity;
    try {
      identity = verifyDocGridAccessToken(token);
    } catch {
      return res.status(401).json({ error: "Invalid DocGrid identity token", requestId: id });
    }

    const repositories = await fetchUpstreamJson<HomeRepository[]>(
      "/api/docgrid/repositories",
      identity,
      id,
    );

    const recentRepositories = repositories.slice(0, 20);
    const perRepositoryLimit = query.mode === "journal" ? 50 : 25;
    const groups = await Promise.all(
      recentRepositories.map(async (repository) => {
        try {
          const activity = await fetchUpstreamJson<HomeActivity[]>(
            `/api/docgrid/repositories/${encodeURIComponent(repository.id)}/activity?limit=${perRepositoryLimit}`,
            identity,
            id,
          );
          return { repository, activity };
        } catch (error) {
          console.warn(JSON.stringify({
            service: "docgrid-bff",
            event: "home.activity.partial_failure",
            requestId: id,
            repositoryId: repository.id,
            reason: error instanceof Error ? error.message : "unknown",
          }));
          return { repository, activity: [] as HomeActivity[] };
        }
      }),
    );

    return res.json(buildHomeDashboard(repositories, groups, query.mode, query.limit));
  } catch (error) {
    return next(error);
  }
});

app.use("/api/docgrid", async (req, res, next) => {
  const id = requestId(req);
  res.setHeader("X-Request-ID", id);
  res.setHeader("Cache-Control", "no-store");

  try {
    const incoming = new URL(req.originalUrl, "https://api.docgrid.ru");
    const route = resolveDocGridRoute(req.method, incoming.pathname, incoming.searchParams);
    if (!route) {
      console.warn(JSON.stringify({
        service: "docgrid-bff",
        event: "route.rejected",
        requestId: id,
        method: req.method,
        path: incoming.pathname,
        query: [...incoming.searchParams.keys()],
      }));
      return res.status(404).json({
        code: "DOCGRID_ROUTE_NOT_ALLOWED",
        error: "Маршрут DocGrid не разрешён",
        requestId: id,
      });
    }

    const token = readBearer(req.header("authorization"));
    if (!token) return res.status(401).json({ error: "Требуется DocGrid access token", requestId: id });

    let identity;
    try {
      identity = verifyDocGridAccessToken(token);
    } catch {
      return res.status(401).json({ error: "Invalid DocGrid identity token", requestId: id });
    }

    const hasBody = ["POST", "PUT"].includes(req.method);
    const rawContentType = req.header("content-type") ?? "";
    const contentType = rawContentType.split(";")[0]?.trim().toLowerCase();
    let upstreamBody: BodyInit | undefined;
    let upstreamContentType = "application/json";
    if (hasBody) {
      if (route.body === "multipart") {
        if (contentType !== "multipart/form-data" || !Buffer.isBuffer(req.body)) {
          return res.status(415).json({ error: "Ожидается multipart/form-data", requestId: id });
        }
        upstreamBody = new Blob([new Uint8Array(req.body as Buffer)]);
        upstreamContentType = rawContentType;
      } else {
        if (contentType !== "application/json") {
          return res.status(415).json({ error: "Ожидается application/json", requestId: id });
        }
        upstreamBody = JSON.stringify(req.body ?? {});
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
          Accept: route.response === "binary" ? "application/octet-stream, application/json" : "application/json",
          ...(hasBody ? { "Content-Type": upstreamContentType } : {}),
          "X-Request-ID": id,
          ...trustedIdentityHeaders(identity),
        },
        body: upstreamBody,
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

    const upstreamType = upstream.headers.get("content-type") ?? "";
    const isJson = /(^|;)\s*application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(upstreamType);

    if (route.response === "binary" && upstream.ok && !isJson) {
      const bytes = await readBoundedBytes(upstream, config.MAX_RESPONSE_BYTES);
      const disposition = upstream.headers.get("content-disposition") ?? "";
      console.info(JSON.stringify({
        service: "docgrid-bff",
        event: "proxy.completed",
        requestId: id,
        method: req.method,
        path: incoming.pathname,
        upstreamStatus: upstream.status,
        latencyMs: Date.now() - started,
        bytes: bytes.byteLength,
      }));
      res.status(upstream.status);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (SAFE_DISPOSITION.test(disposition)) res.setHeader("Content-Disposition", disposition);
      return res.send(bytes);
    }

    const body = await readBounded(upstream, config.MAX_RESPONSE_BYTES);
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
