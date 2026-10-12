import { BadRequestException, Body, Controller, Post, Res, StreamableFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { DocumentToolsService } from './document-tools.service';

// Bound the combined multipart payload while receiving it, before buffering all files.
const storage = {
  _handleFile(req:any,file:any,callback:(error:Error|null,result?:any)=>void){
    const chunks:Buffer[]=[];let size=0,done=false;
    const finish=(error:Error|null,result?:any)=>{if(done)return;done=true;callback(error,result);};
    file.stream.on('data',(chunk:Buffer)=>{
      req.pdfToolBytes=(req.pdfToolBytes||0)+chunk.length;
      if(req.pdfToolBytes>100*1024*1024){chunks.length=0;finish(new BadRequestException('Общий размер PDF превышает 100 МБ'));file.stream.resume();return;}
      if(!done){chunks.push(chunk);size+=chunk.length;}
    });
    file.stream.on('error',(error:Error)=>finish(error));
    file.stream.on('end',()=>finish(null,{buffer:Buffer.concat(chunks),size}));
  },
  _removeFile(_req:any,file:any,callback:(error:Error|null)=>void){delete file.buffer;callback(null);},
};
const upload=FilesInterceptor('files',30,{storage,limits:{fileSize:100*1024*1024,files:30,fields:2,fieldSize:64*1024,parts:32}});

@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/tools')
export class PdfToolsController {
  constructor(private readonly tools:DocumentToolsService){}
  @Post('process') @UseInterceptors(upload)
  async process(@UploadedFiles() files:Array<{originalname:string;buffer:Buffer}>,@Body() body:unknown,@Res({passthrough:true}) response:Response){
    const result=await this.tools.processPdf(files,body);
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    return new StreamableFile(result.bytes,{type:result.mime,disposition:`attachment; filename="result${result.extension}"`});
  }
  @Post('preview') @UseInterceptors(upload)
  async preview(@UploadedFiles() files:Array<{originalname:string;buffer:Buffer}>,@Body('page') page:string,@Res({passthrough:true}) response:Response){
    response.setHeader('Cache-Control','no-store');return this.tools.previewPdf(files,Number(page));
  }
}
