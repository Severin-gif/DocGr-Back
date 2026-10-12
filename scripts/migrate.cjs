// A separate schema also gives DocGrid its own Prisma migration ledger.
const {spawnSync}=require('node:child_process');
const {Client}=require('pg');
const {MIGRATION,recoverDocxMigration}=require('./recover-docx-migration.cjs');
async function main(){
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required to initialize DocGrid');
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('schema','docgrid');
 const env={...process.env,DATABASE_URL:url.toString()};
 const prisma=(...args)=>{const result=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'migrate',...args],{stdio:'inherit',env});if(result.error)throw result.error;if(result.status!==0)throw Error('Prisma migration command failed with status '+result.status);};
 const db=new Client({connectionString:url.toString(),connectionTimeoutMillis:10000});await db.connect();
 try{
  // Serialize repair, ledger resolution and deploy across new instances.
  await db.query("SELECT pg_advisory_lock(hashtext('docgrid-startup-migrations')::bigint)");
  if(await recoverDocxMigration(db)){
   console.log('Verified and completed additive DOCX migration; resolving its failed ledger entry.');
   prisma('resolve','--applied',MIGRATION);
  }
  prisma('deploy');
 }finally{await db.end();}
}
main().catch(error=>{console.error('DocGrid migration startup failed:',error.message);process.exitCode=1;});
