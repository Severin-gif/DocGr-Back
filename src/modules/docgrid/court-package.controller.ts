import { Controller, Get, Post, Body, Param, Query, ParseUUIDPipe, UseGuards, StreamableFile, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { CourtPackageService } from './court-package.service';

@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/repositories/:projectId')
export class CourtPackageController {
  constructor(private readonly packages:CourtPackageService){}
  @Get('packages') list(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.packages.list(user,project);}
  @Post('packages') save(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() body:unknown){return this.packages.capture(user,project,body);}
  @Get('packages/:id/check') check(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string){return this.packages.check(user,project,id);}
  @Get('packages/:id/download')
  async download(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Res({passthrough:true}) res:Response){
    const file=await this.packages.archive(user,project,id);res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.title)}`);res.setHeader('Cache-Control','no-store');return new StreamableFile(file.stream,{type:'application/zip'});
  }
  @Get('branches/:branch/documents/:id/export')
  async document(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('branch',ParseUUIDPipe) branch:string,@Param('id',ParseUUIDPipe) id:string,@Query('revision') revision:string,@Query('format') format:string,@Res({passthrough:true}) res:Response){
    const file=await this.packages.documentFile(user,project,branch,id,Number(revision),format);res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.title)}`);res.setHeader('Cache-Control','no-store');return new StreamableFile(file.bytes,{type:file.mime});
  }
}
