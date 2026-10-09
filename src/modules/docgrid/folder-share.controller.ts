import { Body,Controller,Get,Post,Param,Query,Header,ParseUUIDPipe,UseGuards,UseInterceptors,UploadedFile,Res,StreamableFile,BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { FolderShareService } from './folder-share.service';
function kind(value:string){if(!['material','document'].includes(value))throw new BadRequestException('Недопустимый тип файла');return value;}
function fileResponse(file:{bytes:Buffer;title:string},res:Response){res.setHeader('Cache-Control','no-store');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.title)}`);res.setHeader('X-Content-Type-Options','nosniff');return new StreamableFile(file.bytes,{type:'application/octet-stream'});}
@Controller('api/docgrid/shared')
export class FolderSharePublicController {
 constructor(private readonly shares:FolderShareService){}
 @Get(':token') @Header('Cache-Control','no-store') files(@Param('token') token:string){return this.shares.files(token);}
 @Get(':token/files/:kind/:id/content') @Header('Cache-Control','no-store') content(@Param('token') token:string,@Param('kind') k:string,@Param('id',ParseUUIDPipe) id:string){return this.shares.content(token,kind(k),id);}
 @Get(':token/files/:kind/:id/download') async download(@Param('token') token:string,@Param('kind') k:string,@Param('id',ParseUUIDPipe) id:string,@Res({passthrough:true}) res:Response){return fileResponse(await this.shares.read(token,kind(k),id),res);}
 @Get(':token/manifest')
 @Header('Cache-Control','no-store') @Header('Referrer-Policy','no-referrer') @Header('X-Robots-Tag','noindex, nofollow')
 manifest(@Param('token') token:string,@Query('offset') offset='0',@Query('limit') limit='50',@Query('indexVersion') indexVersion?:string){
  if(!/^\d{1,8}$/.test(offset)||!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>200||(indexVersion!==undefined&&!/^[a-f0-9]{64}$/.test(indexVersion))||(Number(offset)>0&&!indexVersion))throw new BadRequestException('Нужны размер страницы 1–200 и версия списка для продолжения');
  return this.shares.manifest(token,Number(offset),Number(limit),indexVersion);
 }
 @Get(':token/files/:kind/:id/text')
 @Header('Cache-Control','no-store') @Header('Referrer-Policy','no-referrer') @Header('X-Robots-Tag','noindex, nofollow')
 text(@Param('token') token:string,@Param('kind') k:string,@Param('id',ParseUUIDPipe) id:string,@Query('version') version:string,@Query('offset') offset='0',@Query('limit') limit='50000'){
  if(!/^[a-f0-9]{64}$/.test(version||'')||!/^\d{1,8}$/.test(offset)||!/^\d{1,5}$/.test(limit)||Number(limit)<2||Number(limit)>50000)throw new BadRequestException('Нужны версия текста, смещение и размер части 2–50000');
  if(!['material','document','artifact'].includes(k))throw new BadRequestException('Недопустимый источник');
  return this.shares.text(token,k,id,version,Number(offset),Number(limit));
 }
 @UseGuards(DocGridIdentityGuard)
 @Post(':token/proposals') propose(@CurrentUser('id') user:string,@Param('token') token:string,@Body() input:unknown){return this.shares.propose(user,token,input);}
 @UseGuards(DocGridIdentityGuard)
 @Get(':token/proposals') mine(@CurrentUser('id') user:string,@Param('token') token:string){return this.shares.mine(user,token);}
 @UseGuards(DocGridIdentityGuard)
 @Post(':token/uploads')
 @UseInterceptors(FileInterceptor('file',{limits:{fileSize:32*1024*1024,files:1,fields:2}}))
 upload(@CurrentUser('id') user:string,@Param('token') token:string,@UploadedFile() file:{originalname:string;mimetype:string;buffer:Buffer},@Body('path') path?:string,@Body('body') body?:string){return this.shares.upload(user,token,file,path,body);}
}
@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/repositories/:projectId')
export class FolderShareOwnerController {
 constructor(private readonly shares:FolderShareService){}
 @Post('shares') create(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() input:unknown){return this.shares.create(user,project,input);}
 @Get('shares') list(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.shares.list(user,project);}
 @Post('shares/:id/revoke') revoke(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string){return this.shares.revoke(user,project,id);}
 @Get('access-summary') accessSummary(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.shares.accessSummary(user,project);}
 @Get('ai-corpus') coverage(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Query('path') path='/'){return this.shares.coverage(user,project,path);}
 @Post('access/revoke-all') revokeAll(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Body() input:unknown){
  if(!input||typeof input!=='object'||Object.keys(input).length!==1||!['external','all'].includes((input as any).scope))throw new BadRequestException('Выберите scope: external или all');
  return this.shares.revokeAll(user,project,(input as any).scope);
 }
 @Get('shared-proposals') proposals(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.shares.proposals(user,project);}
 @Get('shared-proposals/:id/download') async candidate(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Res({passthrough:true}) res:Response){return fileResponse(await this.shares.candidate(user,project,id),res);}
 @Post('shared-proposals/:id/decide') decide(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Body() input:unknown){
  if(!input||typeof input!=='object'||!['MERGE','CLOSE'].includes((input as any).action)||Object.keys(input).length!==1)throw new BadRequestException('Выберите принять или отклонить');
  return this.shares.decide(user,project,id,(input as any).action==='MERGE');
 }
}
