import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { PrismaService } from '../../../prisma/prisma.service';
import { DocGridIdentityGuard } from '../docgrid-identity.guard';
import { AstraAgentGuard } from './astra-agent.guard';
import { AstraAgentController, AstraHumanController } from './astra.controller';
import { AstraService } from './astra.service';

describe('Astra HTTP privilege boundary', () => {
  const project = '10000000-0000-4000-8000-000000000001';
  const operation = '20000000-0000-4000-8000-000000000001';
  const serviceToken = 's'.repeat(48), agentToken = `dga_${'a'.repeat(43)}`;
  const original = process.env.DOCGRID_SERVICE_TOKEN;
  let app: INestApplication;
  const astra = {
    execute: jest.fn(async (_token: string, tool: string) => {
      if (tool !== 'docgrid_get_capabilities') throw new BadRequestException({ code: 'UNSUPPORTED' });
      return { output: { catalogVersion: 'test' } };
    }),
    describeGrant: jest.fn(async () => ({ tools: [], grant: { agentRef: 'Claude' } })),
    decideOperation: jest.fn(async () => ({ status: 'completed' })),
  };
  beforeAll(async () => {
    process.env.DOCGRID_SERVICE_TOKEN = serviceToken;
    const module = await Test.createTestingModule({
      controllers: [AstraAgentController, AstraHumanController],
      providers: [AstraAgentGuard, DocGridIdentityGuard,
        { provide: AstraService, useValue: astra },
        { provide: PrismaService, useValue: { user: { findFirst: jest.fn(async () => ({ id: 'owner', email: 'owner@example.test', name: null, role: 'USER', plan: 'free', tariff: 'FREE', emailVerifiedAt: new Date(), externalSubject: 'subject' })) } } },
      ],
    }).compile();
    app = module.createNestApplication(); await app.init();
  });
  beforeEach(() => { jest.clearAllMocks(); });
  afterAll(async () => { await app.close(); if (original === undefined) delete process.env.DOCGRID_SERVICE_TOKEN; else process.env.DOCGRID_SERVICE_TOKEN = original; });
  it('generic endpoints use the same grant guard and never expose human approval', async () => {
    const response = await request(app.getHttpServer()).get(`/api/docgrid/agents/catalog?projectId=${project}`)
      .set('x-docgrid-service-token', serviceToken).set('x-docgrid-agent-token', agentToken).expect(200);
    expect(response.body.grant.agentRef).toBe('Claude');
    expect(astra.describeGrant).toHaveBeenCalledWith(agentToken, project);
    await request(app.getHttpServer()).post(`/api/docgrid/repositories/${project}/agents/operations/${operation}/approve`)
      .set('x-docgrid-service-token', serviceToken).set('x-docgrid-agent-token', agentToken).send({}).expect(401);
    expect(astra.decideOperation).not.toHaveBeenCalled();
  });
  it('the agent credential cannot approve on the human route', async () => {
    await request(app.getHttpServer()).post(`/api/docgrid/repositories/${project}/astra/operations/${operation}/approve`)
      .set('x-docgrid-service-token', serviceToken).set('x-docgrid-agent-token', agentToken)
      .send({ requestKey: 'attempt', approvalDigest: 'a'.repeat(64), planRevision: 1 }).expect(401);
    expect(astra.decideOperation).not.toHaveBeenCalled();
  });
  it('the direct namespace exposes no human approval route or tool', async () => {
    await request(app.getHttpServer()).post(`/api/docgrid/astra/operations/${operation}/approve`)
      .set('x-docgrid-service-token', serviceToken).set('x-docgrid-agent-token', agentToken).send({}).expect(404);
    const response = await request(app.getHttpServer()).post('/api/docgrid/astra/tools/docgrid_approve_document')
      .set('x-docgrid-service-token', serviceToken).set('x-docgrid-agent-token', agentToken).send({}).expect(400);
    expect(response.body.code).toBe('UNSUPPORTED'); expect(astra.decideOperation).not.toHaveBeenCalled();
  });
  it('human headers alone cannot execute agent tools', async () => {
    await request(app.getHttpServer()).post('/api/docgrid/astra/tools/docgrid_get_capabilities')
      .set('x-docgrid-service-token', serviceToken).set('x-docgrid-subject', 'subject').set('x-docgrid-email', 'owner@example.test')
      .set('x-docgrid-role', 'USER').set('x-docgrid-plan', 'free').send({}).expect(401);
    expect(astra.execute).not.toHaveBeenCalled();
  });
  it('direct calls pass only the opaque agent credential to the service', async () => {
    const body = { projectId: project, runId: 'run', traceId: 'trace', input: {} };
    await request(app.getHttpServer()).post('/api/docgrid/astra/tools/docgrid_get_capabilities')
      .set('x-docgrid-service-token', serviceToken).set('x-docgrid-agent-token', agentToken)
      .set('x-docgrid-subject', 'spoofed-admin').set('x-docgrid-role', 'ADMIN').send(body).expect(201);
    expect(astra.execute).toHaveBeenCalledWith(agentToken, 'docgrid_get_capabilities', body);
  });
});

