import { Body,Controller,Get,Post,Param,ParseUUIDPipe,UseGuards,UseInterceptors,UploadedFile,Res,StreamableFile,BadRequestException } from '@nestjs/common';
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
 @Get(':token') files(@Param('token') token:string){return this.shares.files(token);}
 @Get(':token/files/:kind/:id/content') content(@Param('token') token:string,@Param('kind') k:string,@Param('id',ParseUUIDPipe) id:string){return this.shares.content(token,kind(k),id);}
 @Get(':token/files/:kind/:id/download') async download(@Param('token') token:string,@Param('kind') k:string,@Param('id',ParseUUIDPipe) id:string,@Res({passthrough:true}) res:Response){return fileResponse(await this.shares.read(token,kind(k),id),res);}
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
 @Get('shared-proposals') proposals(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string){return this.shares.proposals(user,project);}
 @Get('shared-proposals/:id/download') async candidate(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Res({passthrough:true}) res:Response){return fileResponse(await this.shares.candidate(user,project,id),res);}
 @Post('shared-proposals/:id/decide') decide(@CurrentUser('id') user:string,@Param('projectId',ParseUUIDPipe) project:string,@Param('id',ParseUUIDPipe) id:string,@Body() input:unknown){
  if(!input||typeof input!=='object'||!['MERGE','CLOSE'].includes((input as any).action)||Object.keys(input).length!==1)throw new BadRequestException('Выберите принять или отклонить');
  return this.shares.decide(user,project,id,(input as any).action==='MERGE');
 }
}
