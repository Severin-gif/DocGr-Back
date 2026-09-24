import { Router } from "express";
import { readBearer } from "./proxy-policy.js";
import { randomUUID } from "node:crypto";

type Options = {
  upstream: string;
  serviceToken: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetcher?: typeof fetch;
};
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const FILE_ROUTE = new RegExp(`^/api/docgrid/astra/artifacts/${UUID}/versions/([1-9][0-9]{0,8})/(docx|pdf)$`);
const PROJECT_ID = new RegExp(`^${UUID}$`);

// This credential can enter only the agent adapter. It never becomes a human
// identity and cannot reach the browser proxy or human approval endpoints.
export function readAgentToken(header: string | undefined): string | null {
  const token = readBearer(header);
  return token && /^dga_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function createAstraRouter(options: Options): Router {
  const router = Router();
  router.use(async (req, res) => {
    const suppliedId = req.header("x-request-id");
    const requestId = suppliedId && /^[A-Za-z0-9._:-]{1,100}$/.test(suppliedId) ? suppliedId : randomUUID();
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.originalUrl, "https://docgrid.invalid");
    const isTool = req.method === "POST" && /^\/api\/docgrid\/astra\/tools\/docgrid_[a-z_]{1,64}$/.test(url.pathname) && !url.search;
    const fileMatch = req.method === "GET" ? FILE_ROUTE.exec(url.pathname) : null;
    const isFile = fileMatch && [...url.searchParams.keys()].length === 1 && PROJECT_ID.test(url.searchParams.get("projectId") ?? "");
    if (!isTool && !isFile) {
      return res.status(404).json({ code: "UNSUPPORTED", error: "Операция адаптера не поддерживается", requestId });
    }
    const token = readAgentToken(req.header("authorization"));
    if (!token) return res.status(401).json({ code: "INVALID_AGENT_GRANT", error: "Требуется отдельный доступ Astra к DocGrid", requestId });
    if (isTool && !req.is("application/json")) return res.status(415).json({ error: "Ожидается application/json", requestId });
    if (isTool && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) {
      return res.status(400).json({ error: "Ожидается объект запроса", requestId });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnect);
    try {
      const response = await (options.fetcher ?? fetch)(new URL(url.pathname + url.search, options.upstream), {
        method: req.method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: isFile ? "application/octet-stream, application/json" : "application/json",
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
          "X-DocGrid-Service-Token": options.serviceToken,
          "X-DocGrid-Agent-Token": token,
        },
        body: isTool ? JSON.stringify(req.body) : undefined,
      });
      const isJson = /^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? "");
      const binary = isFile && response.ok && !isJson;
      if (!isJson && !binary) {
        await response.body?.cancel();
        return res.status(502).json({ error: "Неподдерживаемый ответ адаптера", requestId });
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (reader) while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > options.maxResponseBytes) {
            await reader.cancel();
            return res.status(502).json({ error: "Ответ адаптера превышает лимит", requestId });
          }
          chunks.push(part.value);
        }
      } finally { reader?.releaseLock(); }
      if (binary) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", `attachment; filename="document-v${fileMatch![1]}.${fileMatch![2]}"`);
        return res.status(response.status).type(fileMatch![2] === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(Buffer.concat(chunks));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      JSON.parse(body); // Never return upstream HTML disguised as JSON.
      return res.status(response.status).type("application/json").send(body);
    } catch {
      return res.status(502).json({ error: "Адаптер DocGrid недоступен", requestId });
    } finally {
      clearTimeout(timeout);
      res.off("close", disconnect);
    }
  });
  return router;
}
