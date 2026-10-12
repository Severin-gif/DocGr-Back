import { Body, Controller, Post, Req, Res, StreamableFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { DocumentToolsService } from './document-tools.service';
import { PdfUploadInterceptor, PdfRequest } from './pdf-upload.interceptor';

@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/tools')
export class PdfToolsController {
  constructor(private readonly tools:DocumentToolsService){}
  @Post('process') @UseInterceptors(PdfUploadInterceptor)
  async process(@Req() req:PdfRequest,@Body() body:unknown,@Res({passthrough:true}) response:Response){
    const result=await this.tools.processPdf(req.files,body,req.pdfLease,req.pdfAbort.signal);
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    return new StreamableFile(result.stream,{type:result.mime,disposition:`attachment; filename="result${result.extension}"`});
  }
  @Post('preview') @UseInterceptors(PdfUploadInterceptor)
  async preview(@Req() req:PdfRequest,@Body('page') page:string,@Res({passthrough:true}) response:Response){
    response.setHeader('Cache-Control','no-store');return this.tools.previewPdf(req.files,Number(page),req.pdfLease,req.pdfAbort.signal);
  }
}
