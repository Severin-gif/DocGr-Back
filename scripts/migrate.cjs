// A separate schema also gives DocGrid its own Prisma migration ledger.
const {spawnSync}=require('node:child_process');
const {Client}=require('pg');
const {provisionRuntimePrivileges}=require('./runtime-privileges.cjs');
const {migrationConnection}=require('./migration-connection.cjs');
const {MIGRATION,recoverDocxMigration}=require('./recover-docx-migration.cjs');
async function main(){
 const url=new URL(migrationConnection());
 const env={...process.env,DATABASE_URL:url.toString()};
 const prisma=(...args)=>{const result=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'migrate',...args,'--schema','prisma/live/schema.prisma'],{stdio:'inherit',env});if(result.error)throw result.error;if(result.status!==0)throw Error('Prisma migration command failed with status '+result.status);};
 const db=new Client({connectionString:url.toString(),connectionTimeoutMillis:10000});await db.connect();
 try{
  // Serialize repair, ledger resolution and deploy across new instances.
  await db.query("SELECT pg_advisory_lock(hashtext('docgrid-startup-migrations')::bigint)");
  if(await recoverDocxMigration(db)){
   console.log('Verified and completed additive DOCX migration; resolving its failed ledger entry.');
   prisma('resolve','--applied',MIGRATION);
  }
  prisma('deploy');
  await provisionRuntimePrivileges(db,process.env.DATABASE_URL);
  // Test the actual API credentials, not the privileged migration connection.
  const runtime=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
  try {
   await runtime.connect();
   await runtime.query('SELECT id FROM docgrid_live."User" LIMIT 0');
   const denied=await runtime.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='docgrid_live' AND
    ((c.relkind IN ('r','p') AND NOT (has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT') AND has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE')))
     OR (c.relkind='S' AND NOT (has_sequence_privilege(current_user,c.oid,'USAGE') AND has_sequence_privilege(current_user,c.oid,'SELECT'))))`);
   if(denied.rows.length)throw Error('Runtime role lacks required docgrid_live object privileges');
  } finally { await runtime.end(); }
 }catch(error){
  if(error.code==='42501'){
   const role=(await db.query('SELECT current_user AS role')).rows[0].role;
   throw Error(`Migration role ${role} lacks ownership privileges. Configure MIGRATION_DATABASE_URL with the owner of existing docgrid_live tables. ${error.message}`);
  }
  throw error;
 }finally{await db.end();}
}
main().catch(error=>{console.error('DocGrid migration startup failed:',error.message);process.exitCode=1;});

