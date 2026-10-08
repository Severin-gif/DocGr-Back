import { BadRequestException } from '@nestjs/common';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runLimitedExtraction } from './docgrid-material-extraction';
export async function editSpreadsheet(title:string,bytes:Buffer,cells:unknown):Promise<Buffer>{
 const dir=await mkdtemp(join(tmpdir(),'docgrid-cell-edit-'));
 try{
  const source=join(dir,'source'),patch=join(dir,'changes.json');
  await writeFile(source,bytes,{mode:0o600});await writeFile(patch,JSON.stringify(cells),{mode:0o600});
  return Buffer.from(await runLimitedExtraction('python3',['-I',resolve(__dirname,'../../../scripts/office-edit.py'),source,title.toLowerCase().endsWith('.xls')?'xls':'xlsx',patch],8000,45*1024*1024),'base64');
 }catch{throw new BadRequestException('Не удалось применить правки Excel. Исходник сохранён.');}
 finally{await rm(dir,{recursive:true,force:true});}
}
