import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { DocumentToolsService } from './document-tools.service';

@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/repositories/:projectId/tools')
export class DocumentToolsController {
  constructor(private readonly tools:DocumentToolsService){}
  @Get('jobs') list(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.tools.list(user,project);}
  @Post('jobs') create(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() body:unknown){return this.tools.enqueue(user,project,body);}
  @Post('inspect') inspect(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() body:unknown){return this.tools.inspect(user,project,body);}
}
