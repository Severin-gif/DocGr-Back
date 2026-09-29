import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { DiscussionService } from './discussion.service';

@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/repositories/:projectId/discussions')
export class DiscussionController {
  constructor(private readonly discussions:DiscussionService){}
  @Get('context') context(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.projectContext(user,project);}
  @Post('context/refresh') refreshContext(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.refreshContext(user,project);}
  @Get('config') config(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.config(user,project);}
  @Put('settings') settings(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() body:unknown){return this.discussions.settings(user,project,body);}
  @Get() list(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.discussions.list(user,project);}
  @Post() create(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() body:unknown){return this.discussions.create(user,project,body);}
  @Get(':id/turns') turns(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string){return this.discussions.turns(user,project,id);}
  @Post(':id/turns') send(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:unknown){return this.discussions.send(user,project,id,body);}
  @Post(':id/turns/:turnId/proposal') propose(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Param('turnId',ParseUUIDPipe) turnId:string){return this.discussions.propose(user,project,id,turnId);}
}

