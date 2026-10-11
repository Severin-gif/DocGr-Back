const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const db=await PGlite.create();
 try {
  await db.exec(`CREATE SCHEMA docgrid; CREATE TABLE docgrid.workspace_projects(id uuid PRIMARY KEY,name text,created_at timestamptz DEFAULT now());
   INSERT INTO docgrid.workspace_projects(id,name) VALUES ('5cf24afd-4e8e-4749-9eef-3147fa622484','Тимаева'),('11111111-1111-4111-8111-111111111111','Тимаева'),('11111111-2222-4222-8222-222222222222','Тимаева'),('22222222-2222-4222-8222-222222222222','⚖️'),('33333333-3333-4333-8333-333333333333','Дело № 42 / Ёж');`);
  const before=(await db.query('SELECT id,name,created_at FROM docgrid.workspace_projects ORDER BY id')).rows;
  await db.exec(fs.readFileSync('prisma/migrations/20261011210000_project_slugs/migration.sql','utf8'));
  const rows=(await db.query('SELECT id,slug FROM docgrid.workspace_projects ORDER BY id')).rows;
  assert.deepEqual((await db.query('SELECT id,name,created_at FROM docgrid.workspace_projects ORDER BY id')).rows,before);
  assert.equal(rows[0].slug,'timaeva');
  assert.equal(new Set(rows.map(row=>row.slug)).size,rows.length);
  assert.equal(rows.find(row=>row.id.startsWith('5cf24afd')).slug,'timaeva--5cf24afd');
  assert.equal(rows.find(row=>row.id.startsWith('22222222')).slug,'project');
  assert.equal(rows.find(row=>row.id.startsWith('33333333')).slug,'delo-42-ezh');
  console.log('PASS existing project backfill, equal names, prefix collisions, Cyrillic, fallback and data preservation');
 } finally {await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
