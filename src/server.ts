import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { config, allowedOrigins } from './config';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { AstraService } from './modules/docgrid/astra/astra.service';
import { AgentOAuthCodeStore } from './modules/docgrid/agent-oauth.controller';
import { createAgentOAuthRouter } from './agent-oauth';
import { createAgentMcpRouter } from './agent-mcp';
import { localAgentTransport } from './local-agent-transport';

export async function createApplication() {
  const server = express();
  server.disable('x-powered-by');
  server.set('trust proxy', 1);
  server.use(helmet());
  server.use(cors({ credentials: false, methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID', 'MCP-Protocol-Version'],
    exposedHeaders: ['X-Request-ID', 'WWW-Authenticate'],
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || origin === config.DOCGRID_PUBLIC_ORIGIN) return callback(null, true);
      callback(Object.assign(new Error('Origin is not allowed'), { status: 403 }));
    },
  }));
  server.use(express.json({ limit: '2mb', strict: true }));
  server.use((req, res, next) => {
    const supplied = req.header('x-request-id');
    const id = supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-ID', id);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { bodyParser: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.enableShutdownHooks();
  server.get('/health', (_req, res) => res.json({ status: 'ok', service: 'docgrid-back' }));
  server.get('/ready', async (_req, res) => {
    try {
      await app.get(PrismaService).$queryRaw`SELECT id FROM docgrid.workspace_projects LIMIT 1`;
      res.json({ status: 'ready', database: 'docgrid', storage: process.env.DOCGRID_MATERIAL_STORAGE || 'database' });
    } catch { res.status(503).json({ status: 'not_ready', database: 'docgrid' }); }
  });
  const options = {
    // URL parsing only: requests dispatch to local services, never to this host.
    upstream: 'http://docgrid.internal', serviceToken: config.DOCGRID_SERVICE_TOKEN,
    timeoutMs: config.UPSTREAM_TIMEOUT_MS, maxResponseBytes: config.MAX_RESPONSE_BYTES,
    publicOrigin: config.DOCGRID_PUBLIC_ORIGIN, allowedOrigins: [...allowedOrigins, config.DOCGRID_PUBLIC_ORIGIN],
    fetcher: localAgentTransport(app.get(AstraService), app.get(AgentOAuthCodeStore)),
  };
  server.use(createAgentOAuthRouter(options));
  server.use('/api/docgrid/mcp', createAgentMcpRouter(options));
  await app.init();
  return app;
}

if (require.main === module) {
  createApplication().then(app => app.listen(config.PORT, '0.0.0.0')).catch(() => {
    console.error('DocGrid startup failed. Check database and storage configuration.');
    process.exitCode = 1;
  });
}
