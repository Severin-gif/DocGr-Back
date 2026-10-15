require('reflect-metadata');
const assert = require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,readdir,rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {DocGridBackupService} = require('../dist/modules/docgrid/docgrid-backup.service');
async function settled(service) {
 const deadline=Date.now()+10000;
 while(service.status().active && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
 assert.equal(service.status().active,false);
}
(async()=>{
 const old = {...process.env}; const dir = await mkdtemp(join(tmpdir(),'backup-regression-')); const services=[];
 try {
  await mkdir(join(dir,'bin')); await mkdir(join(dir,'copies'));
  process.env.PATH=join(dir,'bin')+':'+old.PATH; process.env.DOCGRID_BACKUP_DIR=join(dir,'copies');
  const script=join(dir,'bin','pg_dump');
  await writeFile(script,'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o700});
  const legacyStatus=JSON.stringify({lastSuccess:new Date().toISOString()});
  await writeFile(join(dir,'copies','status.json'),legacyStatus); await writeFile(join(dir,'copies','docgrid-old.dump'),'legacy');
  for(const schema of ['docgrid_live','another_schema']) {
   process.env.DATABASE_URL='postgresql://test:test@localhost/db?schema='+schema;
   const s=new DocGridBackupService(); services.push(s); await s.onModuleInit(); await settled(s); s.onModuleDestroy();
   assert.ok(s.status().lastSuccess); assert.equal(s.status().lastError,null);
   const folder=join(dir,'copies',schema); const dump=(await readdir(folder)).find(n=>n.endsWith('.dump'));
   assert.ok((await readFile(join(folder,dump),'utf8')).includes('--schema='+schema));
   const fresh=new DocGridBackupService();services.push(fresh);await fresh.onModuleInit();await settled(fresh);fresh.onModuleDestroy();
   assert.equal(fresh.status().lastSuccess,s.status().lastSuccess);
   assert.equal((await readdir(folder)).filter(n=>n.endsWith('.dump')).length,1);
   await writeFile(script,'#!/bin/sh\nprintf incomplete; exit 1\n',{mode:0o700});
   assert.match((await s.backup()).lastError,/failed/);assert.equal(s.status().lastSuccess,fresh.status().lastSuccess);
   assert.equal((await readdir(folder)).filter(n=>n.endsWith('.partial')).length,0);
   await writeFile(script,'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o700});
  }
  process.env.DATABASE_URL='postgresql://test:test@localhost/db?schema=docgrid_live';
  const folder=join(dir,'copies','docgrid_live');
  const beforeOther=await readdir(join(dir,'copies','another_schema'));
  for(let i=0;i<20;i++) await writeFile(join(folder,`docgrid-2000-${String(i).padStart(2,'0')}.dump`),'old');
  const s=new DocGridBackupService();await s.backup();
  assert.equal((await readdir(folder)).filter(n=>n.endsWith('.dump')).length,14);
  assert.deepEqual(await readdir(join(dir,'copies','another_schema')),beforeOther);
  await writeFile(join(folder,'.backup.lock'),'other');
  assert.match((await s.backup()).lastError,/lock/);
  assert.equal(await readFile(join(folder,'.backup.lock'),'utf8'),'other');
  await rm(join(folder,'.backup.lock'));
  await writeFile(join(folder,'status.json'),JSON.stringify({schema:'docgrid',lastSuccess:new Date().toISOString()}));
  const mismatch=new DocGridBackupService();services.push(mismatch);await mismatch.onModuleInit();await settled(mismatch);mismatch.onModuleDestroy();
  assert.ok(mismatch.status().lastSuccess);
  assert.equal(JSON.parse(await readFile(join(folder,'status.json'),'utf8')).schema,'docgrid_live');
  assert.equal(await readFile(join(dir,'copies','status.json'),'utf8'),legacyStatus);
  assert.equal(await readFile(join(dir,'copies','docgrid-old.dump'),'utf8'),'legacy');
  console.log('PASS immediate cutover backup, per-schema status/dump, restart freshness, failure retention, legacy files preserved');
 } finally {services.forEach(s=>s.onModuleDestroy());process.env=old;await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
