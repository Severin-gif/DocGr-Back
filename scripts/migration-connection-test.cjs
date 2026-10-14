const assert=require('node:assert/strict');const {migrationConnection}=require('./migration-connection.cjs');
const runtime='postgresql://runtime:runtime-secret@db.example:5432/DocGrid?schema=docgrid_live';
const owner='postgresql://owner:owner-secret@db.example:5432/DocGrid?sslmode=require';
assert.equal(new URL(migrationConnection({DATABASE_URL:runtime})).username,'runtime');
const env={DATABASE_URL:runtime,MIGRATION_DATABASE_URL:owner};
const result=new URL(migrationConnection(env));assert.equal(result.username,'owner');assert.equal(result.searchParams.get('schema'),'docgrid_live');assert.equal(result.searchParams.get('sslmode'),'require');assert.equal(env.DATABASE_URL,runtime);
for(const value of [owner.replace('/DocGrid','/Other'),owner.replace('db.example','other.example'),owner.replace(':5432',':5433'),'owner-secret']){
 assert.throws(()=>migrationConnection({...env,MIGRATION_DATABASE_URL:value}),error=>!error.message.includes('owner-secret')&&!error.message.includes('runtime-secret'));
}
assert.throws(()=>migrationConnection({}));
assert.throws(()=>migrationConnection({DATABASE_URL:runtime.replace('?schema=docgrid_live','')}),/schema=docgrid_live/);
assert.throws(()=>migrationConnection({...env,MIGRATION_DATABASE_URL:owner+'&schema=docgrid'}),/schema=docgrid_live/);
console.log('PASS migration credentials override, same-database enforcement, runtime credentials preserved and secret-safe errors');

