import { DiscussionWorkflowService } from './discussion-workflow.service';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { DiscussionService } from './discussion.service';

@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/repositories/:projectId/discussions')
export class DiscussionController {
  constructor(private readonly discussions:DiscussionService,private readonly workflows:DiscussionWorkflowService){}
  @Get('context') context(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.projectContext(user,project);}
  @Post('context/refresh') refreshContext(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.refreshContext(user,project);}
  @Get('config') config(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.config(user,project);}
  @Put('settings') settings(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() body:unknown){return this.discussions.settings(user,project,body);}
  @Get() list(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.list(user,project);}
  @Post() create(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() body:unknown){return this.discussions.create(user,project,body);}
  @Get(':id/turns') turns(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string){return this.discussions.turns(user,project,id);}
  @Post(':id/turns') send(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:unknown){return this.discussions.send(user,project,id,body);}
  @Post(':id/turns/:turnId/proposal') propose(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Param('turnId',ParseUUIDPipe) turnId:string){return this.discussions.propose(user,project,id,turnId);}
  @Get(':id/workflows') workflowsList(@CurrentUser('id') u:string,@Param('projectId',ParseUUIDPipe) p:string,@Param('id',ParseUUIDPipe) id:string){return this.workflows.list(u,p,id);}
  @Get(':id/capabilities') capabilities(@CurrentUser('id') u:string,@Param('projectId',ParseUUIDPipe) p:string,@Param('id',ParseUUIDPipe) id:string){return this.workflows.capabilities(u,p,id);}
  @Post(':id/workflows') plan(@CurrentUser('id') u:string,@Param('projectId',ParseUUIDPipe) p:string,@Param('id',ParseUUIDPipe) id:string,@Body() b:unknown){return this.workflows.create(u,p,id,b);}
  @Post(':id/workflows/:workflowId/run') run(@CurrentUser('id') u:string,@Param('projectId',ParseUUIDPipe) p:string,@Param('id',ParseUUIDPipe) id:string,@Param('workflowId',ParseUUIDPipe) w:string,@Body() b:unknown){return this.workflows.run(u,p,id,w,b);}
  @Post(':id/workflows/:workflowId/cancel') cancel(@CurrentUser('id') u:string,@Param('projectId',ParseUUIDPipe) p:string,@Param('id',ParseUUIDPipe) id:string,@Param('workflowId',ParseUUIDPipe) w:string,@Body() b:unknown){return this.workflows.cancel(u,p,id,w,b);}
}

