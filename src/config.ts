import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DOCGRID_PUBLIC_ORIGIN: z.string().url().default("https://api.docgrid.ru"),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  CORS_ORIGINS: z.string().default("https://docgrid.ru,https://www.docgrid.ru,http://localhost:3000"),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(90_000),
  FILE_TRANSFER_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(300_000),
  UPSTREAM_READY_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(5_000),
  MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_000_000).max(64_000_000).default(32_000_000),
  DOCGRID_IDENTITY_JWT_SECRET: z.string().min(32),
  DOCGRID_IDENTITY_ISSUER: z.string().min(1).default("ai-orchestra"),
  DOCGRID_IDENTITY_AUDIENCE: z.string().min(1).default("legal-core-docgrid"),
  DOCGRID_SERVICE_TOKEN: z.string().min(32),
});

export const config = schema.parse(process.env);
const publicUrl = new URL(config.DOCGRID_PUBLIC_ORIGIN);
if (publicUrl.origin !== config.DOCGRID_PUBLIC_ORIGIN || publicUrl.username || publicUrl.password || (publicUrl.protocol !== 'https:' && !(config.NODE_ENV !== 'production' && ['127.0.0.1','localhost'].includes(publicUrl.hostname)))) throw new Error('DOCGRID_PUBLIC_ORIGIN must be a canonical HTTPS origin');

export const allowedOrigins = [...new Set(
  config.CORS_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
)];

