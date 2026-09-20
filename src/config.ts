import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  LEGAL_CORE_URL: z.string().url(),
  CORS_ORIGINS: z.string().default("https://docgrid.ru,https://www.docgrid.ru,http://localhost:3000"),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(90_000),
  UPSTREAM_READY_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(5_000),
  MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_000_000).max(64_000_000).default(32_000_000),
});

export const config = schema.parse(process.env);

function normalizeLegalCoreUrl(raw: string): string {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (config.NODE_ENV === "production" && url.protocol !== "https:" && !local) {
    throw new Error("LEGAL_CORE_URL must use HTTPS in production");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid LEGAL_CORE_URL");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  url.pathname = pathname || "/";
  return url.toString().replace(/\/+$/, "");
}

export const legalCoreUrl = normalizeLegalCoreUrl(config.LEGAL_CORE_URL);
export const allowedOrigins = [...new Set(
  config.CORS_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
)];
