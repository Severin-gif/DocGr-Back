import { lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Normal lifecycle: <=60s upload +75s processing +60s response. This longer
// retention protects live requests and removes leftovers from a killed process.
export const PDF_UPLOAD_RETENTION_MS=10*60*1000;
export async function cleanupExpiredPdfUploads(root=tmpdir(),now=Date.now()){
  const entries=await readdir(root,{withFileTypes:true});
  for(const entry of entries){
    if(!entry.isDirectory()||!/^dg-pdf-[a-zA-Z0-9]+$/.test(entry.name))continue;
    const path=join(root,entry.name);
    try{
      const info=await lstat(path);
      if(info.isDirectory()&&info.mtimeMs<now-PDF_UPLOAD_RETENTION_MS)await rm(path,{recursive:true,force:true});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
