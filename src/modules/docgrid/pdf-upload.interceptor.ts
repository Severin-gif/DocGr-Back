import { BadRequestException, CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor, RequestTimeoutException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { defer, lastValueFrom } from 'rxjs';
import { DocumentToolsService, PdfFile, ToolLease } from './document-tools.service';

export type PdfRequest=Omit<Request,'files'> & {files:PdfFile[];pdfDir:string;pdfBytes:number;pdfAbort:AbortController;pdfLease:ToolLease;pdfWrites:Set<Promise<void>>};
const storage={
  _handleFile(req:PdfRequest,file:any,callback:(error:Error|null,result?:any)=>void){
    const path=join(req.pdfDir,randomUUID()+'.pdf');
    const counter=new Transform({transform(chunk:Buffer,_encoding,done){
      req.pdfBytes+=chunk.length;
      done(req.pdfBytes>100*1024*1024?new BadRequestException('Общий размер PDF превышает 100 МБ'):null,chunk);
    }});
    // Backpressure bounds in-flight memory; names never become paths.
    const writing=pipeline(file.stream,counter,createWriteStream(path,{flags:'wx',mode:0o600}),{signal:req.pdfAbort.signal})
      .then(async()=>callback(null,{path,size:(await stat(path)).size}))
      .catch(error=>callback(error));
    req.pdfWrites.add(writing);void writing.finally(()=>req.pdfWrites.delete(writing));
  },
  _removeFile(_req:PdfRequest,file:any,callback:(error:Error|null)=>void){
    void rm(file.path,{force:true}).then(()=>callback(null),callback);
  },
};
const Upload=FilesInterceptor('files',30,{storage,limits:{fileSize:100*1024*1024,files:30,fields:2,fieldSize:64*1024,parts:32}});

@Injectable()
export class PdfUploadInterceptor implements NestInterceptor {
  constructor(private readonly tools:DocumentToolsService){}
  private readonly logger=new Logger('PdfUpload');
  responseTimeoutMs(){return 60000;}
  uploadTimeoutMs(){return 60000;}
  intercept(context:ExecutionContext,next:CallHandler){
    return defer(async()=>{
      const req=context.switchToHttp().getRequest<PdfRequest>();
      const res=context.switchToHttp().getResponse<Response>();
      // Admission is synchronous and precedes multipart parsing or filesystem allocation.
      const lease=this.tools.acquireOperation();req.pdfLease=lease;
      req.pdfAbort=new AbortController();req.pdfBytes=0;req.pdfWrites=new Set();
      const abort=()=>req.pdfAbort.abort(new BadRequestException('Запрос отменён'));
      const close=()=>{if(!res.writableEnded)abort();};
      req.on('aborted',abort);res.on('close',close);
      const timer=setTimeout(()=>req.pdfAbort.abort(new RequestTimeoutException('Превышено время загрузки PDF')),this.uploadTimeoutMs());
      timer.unref();
      let responseTimer:NodeJS.Timeout|undefined;
      let responding=false,cleaned=false;
      const cleanup=async()=>{
        if(cleaned)return;cleaned=true;
        clearTimeout(timer);if(responseTimer)clearTimeout(responseTimer);
        req.off('aborted',abort);res.off('close',close);
        res.off('finish',afterResponse);res.off('close',afterResponse);
        try{await Promise.allSettled(req.pdfWrites);if(req.pdfDir)await rm(req.pdfDir,{recursive:true,force:true});}
        finally{lease.release();}
      };
      const afterResponse=()=>{void cleanup().catch(()=>this.logger.warn('PDF temporary directory cleanup failed'));};
      try{
        req.pdfDir=await mkdtemp(join(tmpdir(),'dg-pdf-'));
        if(req.aborted)abort();req.pdfAbort.signal.throwIfAborted();
        // Also terminate stalled requests without an active file pipeline.
        const upload=new Upload();
        const abortPromise=new Promise<never>((_,reject)=>{
          req.pdfAbort.signal.addEventListener('abort',()=>reject(req.pdfAbort.signal.reason),{once:true});
        });
        const handling=upload.intercept(context,{handle:()=>{
          clearTimeout(timer);
          req.pdfAbort.signal.throwIfAborted();
          return next.handle();
        }});
        // On cancellation wait for Multer/engine to close their writers before cleanup.
        const completion=Promise.resolve(handling).then(observable=>lastValueFrom(observable));
        try{
          const result=await Promise.race([completion,abortPromise]);
          // Keep the directory and slot through the streamed response, including slow clients.
          responding=true;res.once('finish',afterResponse);res.once('close',afterResponse);
          responseTimer=setTimeout(()=>res.destroy(),this.responseTimeoutMs());responseTimer.unref();
          if(res.destroyed||res.writableFinished)afterResponse();
          return result;
        }
        catch(error){
          abort();
          // Multer can wait for an incomplete multipart body; destroy it to finish parsing.
          if(!req.aborted&&(error instanceof RequestTimeoutException)) req.destroy();
          await completion.catch(()=>{});throw error;
        }
      }finally{
        if(!responding)await cleanup();
      }
    });
  }
}
