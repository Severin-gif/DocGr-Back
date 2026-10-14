const assert=require('node:assert/strict');const {PGlite}=require('@electric-sql/pglite');
const {recoverDocxMigration,MIGRATION}=require('./recover-docx-migration.cjs');
async function setup(){const db=await PGlite.create();await db.exec(`CREATE SCHEMA docgrid_live;CREATE TABLE docgrid_live._prisma_migrations(id text,migration_name text,finished_at timestamptz,rolled_back_at timestamptz);INSERT INTO docgrid_live._prisma_migrations(id,migration_name) VALUES('failed','${MIGRATION}');CREATE TABLE docgrid_live.docgrid_branch_documents(id text PRIMARY KEY,content text);CREATE TABLE docgrid_live.docgrid_commits(id text PRIMARY KEY,content text);INSERT INTO docgrid_live.docgrid_branch_documents VALUES('doc','Original document');INSERT INTO docgrid_live.docgrid_commits VALUES('commit','Original revision');`);return db;}
(async()=>{
 for(const stage of ['none','partial','complete']){const db=await setup();try{
  if(stage!=='none')await db.exec('ALTER TABLE docgrid_live.docgrid_branch_documents ADD COLUMN docx_bytes bytea');
  if(stage==='complete'){await recoverDocxMigration(db);await db.exec("UPDATE docgrid_live.docgrid_branch_documents SET docx_bytes=decode('010203','hex'),docx_sha256='digest',format_version='v1'");}
  assert.equal(await recoverDocxMigration(db),true);
  assert.equal((await db.query('SELECT content FROM docgrid_live.docgrid_branch_documents')).rows[0].content,'Original document');
  assert.equal((await db.query('SELECT content FROM docgrid_live.docgrid_commits')).rows[0].content,'Original revision');
  if(stage==='complete')assert.equal((await db.query("SELECT encode(docx_bytes,'hex') AS bytes FROM docgrid_live.docgrid_branch_documents")).rows[0].bytes,'010203');
  assert.equal((await db.query('SELECT finished_at FROM docgrid_live._prisma_migrations')).rows[0].finished_at,null);
  await db.exec('UPDATE docgrid_live._prisma_migrations SET finished_at=now()');assert.equal(await recoverDocxMigration(db),false);
 }finally{await db.close();}}
 for(const kind of ['wrong_type','wrong_constraint','bad_data','missing_table']){const db=await setup();try{
  if(kind==='wrong_type')await db.exec('ALTER TABLE docgrid_live.docgrid_branch_documents ADD COLUMN docx_bytes text');
  if(kind==='wrong_constraint')await db.exec('ALTER TABLE docgrid_live.docgrid_commits ADD CONSTRAINT dg_commit_docx_snapshot CHECK(content IS NOT NULL)');
  if(kind==='bad_data')await db.exec("ALTER TABLE docgrid_live.docgrid_commits ADD COLUMN docx_bytes bytea;UPDATE docgrid_live.docgrid_commits SET docx_bytes=decode('0102','hex')");
  if(kind==='missing_table')await db.exec('DROP TABLE docgrid_live.docgrid_commits');
  await assert.rejects(()=>recoverDocxMigration(db));
  assert.equal((await db.query('SELECT content FROM docgrid_live.docgrid_branch_documents')).rows[0].content,'Original document');
  assert.equal((await db.query('SELECT finished_at FROM docgrid_live._prisma_migrations')).rows[0].finished_at,null);
  assert.equal((await db.query("SELECT count(*) AS n FROM pg_attribute WHERE attrelid='docgrid_live.docgrid_branch_documents'::regclass AND attname='format_version' AND NOT attisdropped")).rows[0].n,0);
 }finally{await db.close();}}
 const db=await PGlite.create();try{assert.equal(await recoverDocxMigration(db),false);}finally{await db.close();}
 console.log('PASS DOCX recovery: new/healthy DB no-op, partial/complete DDL, data preservation, incompatible states refused');
})().catch(error=>{console.error(error);process.exitCode=1});

