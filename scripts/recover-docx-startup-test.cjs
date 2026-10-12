const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const {PGlite}=require('@electric-sql/pglite');const {Client}=require('pg');const {MIGRATION}=require('./recover-docx-migration.cjs');
(async()=>{
 const db=await PGlite.create();const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');
 const socket=new PGLiteSocketServer({db,port:0,host:'127.0.0.1',maxConnections:4});await socket.start();
 const connectionString='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres?schema=docgrid';
 const client=new Client({connectionString});await client.connect();
 const run=()=>new Promise((resolve,reject)=>{let output='';const p=spawn(process.execPath,['scripts/migrate.cjs'],{env:{...process.env,DATABASE_URL:connectionString}});p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('error',reject);p.on('exit',code=>resolve({code,output}));});
 try{
  let r=await run();assert.equal(r.code,0,r.output);
  await client.query('ALTER TABLE docgrid.docgrid_branch_documents DROP CONSTRAINT dg_branch_docx_snapshot; ALTER TABLE docgrid.docgrid_branch_documents DROP COLUMN format_version');
  await client.query('UPDATE docgrid._prisma_migrations SET finished_at=NULL,applied_steps_count=0,logs=$2 WHERE migration_name=$1',[MIGRATION,'synthetic interrupted migration']);
  r=await run();assert.equal(r.code,0,r.output);assert.match(r.output,/Verified and completed/);
  assert.equal((await client.query('SELECT count(*) AS n FROM docgrid._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL')).rows[0].n,'0');
  r=await run();assert.equal(r.code,0,r.output);assert.ok(!r.output.includes('Verified and completed'));
  await client.query("UPDATE docgrid._prisma_migrations SET finished_at=NULL WHERE migration_name='20261011093000_docgrid_user_admin'");
  r=await run();assert.notEqual(r.code,0);assert.match(r.output,/P3009/);
  assert.equal((await client.query("SELECT count(*) AS n FROM docgrid._prisma_migrations WHERE migration_name='20261011093000_docgrid_user_admin' AND finished_at IS NULL AND rolled_back_at IS NULL")).rows[0].n,'1');
  console.log('PASS startup: fresh migrate, partial DOCX repair, Prisma resolve/deploy, repeated boot, unrelated failed migration remains blocked');
 }finally{await client.end();await socket.stop();await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
