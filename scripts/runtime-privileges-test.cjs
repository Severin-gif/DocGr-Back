const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { provisionRuntimePrivileges } = require('./runtime-privileges.cjs');
(async () => {
 const db = await PGlite.create();
 try {
  await db.exec(`CREATE ROLE migration_owner; CREATE ROLE "api'role";
   CREATE ROLE legacy_owner;
   CREATE SCHEMA docgrid AUTHORIZATION legacy_owner;
   CREATE TABLE docgrid.saved (value text); INSERT INTO docgrid.saved VALUES ('keep');
   ALTER TABLE docgrid.saved OWNER TO legacy_owner;
   CREATE SCHEMA docgrid_live AUTHORIZATION migration_owner;
   SET ROLE migration_owner;
   CREATE TABLE docgrid_live.example (id serial PRIMARY KEY, value text);`);
  await provisionRuntimePrivileges(db, 'postgresql://api%27role:secret@localhost/db');
  await provisionRuntimePrivileges(db, 'postgresql://api%27role:secret@localhost/db');
  await db.exec('CREATE TABLE docgrid_live.future (id serial PRIMARY KEY, value text); RESET ROLE; SET ROLE "api\'role";');
  for (const table of ['example', 'future']) {
   await db.exec(`INSERT INTO docgrid_live.${table}(value) VALUES ('ok'); UPDATE docgrid_live.${table} SET value='updated';`);
   assert.equal((await db.query(`SELECT value FROM docgrid_live.${table}`)).rows[0].value, 'updated');
   await db.exec(`DELETE FROM docgrid_live.${table};`);
  }
  await assert.rejects(() => db.exec('SELECT * FROM docgrid.saved'), /permission denied/);
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT value FROM docgrid.saved')).rows[0].value, 'keep');
  assert.deepEqual((await db.query("SELECT tableowner FROM pg_tables WHERE schemaname='docgrid_live'")).rows.map(r=>r.tableowner),['migration_owner','migration_owner']);
  assert.equal((await db.query("SELECT tableowner FROM pg_tables WHERE schemaname='docgrid'")).rows[0].tableowner,'legacy_owner');
  console.log('PASS split migration/runtime roles, quoted role, CRUD, sequences, future objects, repeat provisioning, legacy ACL/data/owners');
 } finally { await db.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
