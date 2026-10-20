import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { AstraService } from './astra/astra.service';
import { uuidInput } from './astra/astra.contracts';
import { config } from '../../config';

@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/integrations')
export class IntegrationsController {
  constructor(private readonly db: PrismaService) {}
  @Get()
  async list(@CurrentUser('id') user: string, @Query('cursor') rawCursor?: string) {
    const cursor=rawCursor?uuidInput({cursor:rawCursor},'cursor'):null;
    const projects=await this.db.$queryRaw<any[]>`SELECT p.id,p.name,p.slug,
      (SELECT count(*)::int FROM docgrid_live.dg_astra_grants g WHERE g.project_id=p.id AND g.owner_id=${user} AND g.builtin=false AND g.revoked_at IS NULL AND g.expires_at>now() AND g.used_operations<g.max_operations) AS "activeConnections"
      FROM docgrid_live.workspace_projects p WHERE p.owner_id=${user} AND (${cursor}::uuid IS NULL OR p.id>${cursor}::uuid) ORDER BY p.id LIMIT 51`;
    return {projects:projects.slice(0,50),nextCursor:projects.length>50?projects[49].id:null,
      mcpUrl:`${config.DOCGRID_PUBLIC_ORIGIN}/api/docgrid/mcp`,apiUrl:`${config.DOCGRID_PUBLIC_ORIGIN}/api/docgrid/v1`,
      openapiUrl:`${config.DOCGRID_PUBLIC_ORIGIN}/api/docgrid/openapi.json`};
  }
}

@Controller('api/docgrid')
export class IntegrationSchemaController {
  constructor(private readonly agents: AstraService) {}
  @Get('openapi.json') schema() {
    const paths: Record<string, unknown> = {};
    for (const tool of this.agents.publicCatalog().tools) {
      const schema = {
        type:'object', additionalProperties:false,
        required:['runId','traceId','input',...(tool.mutating?['requestKey']:[])],
        properties:{
          runId:{type:'string',minLength:1,maxLength:120},
          traceId:{type:'string',minLength:1,maxLength:120},
          requestKey:{type:'string',minLength:1,maxLength:120,description:'Reuse for an exact retry; required for snapshot capture and mutations'},
          input:tool.inputSchema,
        },
      };
      paths[`/tools/${tool.name}`] = {post:{
        operationId:tool.name, summary:tool.description,
        'x-openai-isConsequential':tool.mutating||Boolean(tool.mutationCondition),
        requestBody:{required:true,content:{'application/json':{schema}}},
        responses:{
          '201':{description:'Durable operation. Inspect status: completed, needs_user_action or failed.',content:{'application/json':{schema:{type:'object',properties:{id:{type:'string'},status:{type:'string'},output:{},error:{}}}}}},
          '401':{description:'Invalid key'},'403':{description:'Expired, revoked, exhausted or outside scope'},
        },
      }};
    }
    return {
      openapi:'3.1.0',info:{title:'DocGrid external AI API',version:'1.2.0',description:'Scoped project keys. Human approval stays in DocGrid. Model assessments do not guarantee correctness.'},
      servers:[{url:`${config.DOCGRID_PUBLIC_ORIGIN}/api/docgrid/v1`}],security:[{DocGridKey:[]}],
      components:{securitySchemes:{DocGridKey:{type:'http',scheme:'bearer',bearerFormat:'dga_...'}}}, paths,
    };
  }
}
