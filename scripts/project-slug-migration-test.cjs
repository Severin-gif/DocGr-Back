const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const db=await PGlite.create();
 try {
  await db.exec(`CREATE SCHEMA docgrid_live; CREATE TABLE docgrid_live.workspace_projects(id uuid PRIMARY KEY,name text,created_at timestamptz DEFAULT now());
   INSERT INTO docgrid_live.workspace_projects(id,name) VALUES ('5cf24afd-4e8e-4749-9eef-3147fa622484','Тимаева'),('11111111-1111-4111-8111-111111111111','Тимаева'),('11111111-2222-4222-8222-222222222222','Тимаева'),('22222222-2222-4222-8222-222222222222','⚖️'),('33333333-3333-4333-8333-333333333333','Дело № 42 / Ёж');`);
  await db.exec(`CREATE TABLE docgrid_live.workspace_documents(id uuid PRIMARY KEY, project_id uuid REFERENCES docgrid_live.workspace_projects(id), content text);
    INSERT INTO docgrid_live.workspace_documents VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','5cf24afd-4e8e-4749-9eef-3147fa622484','Immutable project evidence');`);
  const documentsBefore = (await db.query('SELECT * FROM docgrid_live.workspace_documents')).rows;
  const before=(await db.query('SELECT id,name,created_at FROM docgrid_live.workspace_projects ORDER BY id')).rows;
  await db.exec(fs.readFileSync('prisma/live/migrations/20261011210000_project_slugs/migration.sql','utf8'));
  const rows=(await db.query('SELECT id,slug FROM docgrid_live.workspace_projects ORDER BY id')).rows;
  assert.deepEqual((await db.query('SELECT id,name,created_at FROM docgrid_live.workspace_projects ORDER BY id')).rows,before);
  assert.equal(rows[0].slug,'timaeva');
  assert.equal(new Set(rows.map(row=>row.slug)).size,rows.length);
  assert.equal(rows.find(row=>row.id.startsWith('5cf24afd')).slug,'timaeva--5cf24afd');
  assert.equal(rows.find(row=>row.id.startsWith('22222222')).slug,'project');
  assert.equal(rows.find(row=>row.id.startsWith('33333333')).slug,'delo-42-ezh');
  // Simulate an old container writing after the original one-time backfill.
  const lateId = '44444444-4444-4444-8444-444444444444';
  await db.query('INSERT INTO docgrid_live.workspace_projects(id,name) VALUES($1,$2)', [lateId, 'Тимаева']);
  assert.equal((await db.query('SELECT slug FROM docgrid_live.workspace_projects WHERE id=$1', [lateId])).rows[0].slug, null);
  const snapshot = (await db.query('SELECT * FROM docgrid_live.workspace_projects ORDER BY id')).rows;
  await db.exec(fs.readFileSync('prisma/live/migrations/20261012070000_project_slug_rollout/migration.sql', 'utf8'));
  const repaired = (await db.query('SELECT * FROM docgrid_live.workspace_projects ORDER BY id')).rows;
  assert.deepEqual(repaired.map(({slug, ...row}) => row), snapshot.map(({slug, ...row}) => row));
  for (const before of snapshot) {
    const after = repaired.find(row => row.id === before.id);
    if (before.slug !== null) assert.equal(after.slug, before.slug);
    else assert.equal(after.slug, 'timaeva--44444444');
  }
  const insert = async (id, name, slug) => (await db.query(
    'INSERT INTO docgrid_live.workspace_projects(id,name,slug) VALUES($1,$2,$3) RETURNING id,slug', [id, name, slug],
  )).rows[0];
  const legacy = await insert('55555555-5555-4555-8555-555555555555', 'Тимаева', null);
  assert.equal(legacy.slug, 'timaeva--55555555');
  // Old writer omits slug entirely; NEW.id includes the normal DB default.
  await db.exec('ALTER TABLE docgrid_live.workspace_projects ALTER COLUMN id SET DEFAULT gen_random_uuid()');
  const omitted = (await db.query("INSERT INTO docgrid_live.workspace_projects(name) VALUES ('Ёж') RETURNING id,slug")).rows[0];
  assert.equal(omitted.slug, 'ezh');
  const newWriter = await insert('66666666-6666-4666-8666-666666666666', 'Тимаева', 'custom-existing-address');
  assert.equal(newWriter.slug, 'custom-existing-address');
  const collision = await insert('55555555-6666-4666-8666-666666666666', 'Тимаева', null);
  assert.equal(collision.slug, 'timaeva--55555555-1');
  const emoji = await insert('77777777-7777-4777-8777-777777777777', '⚖️', null);
  assert.equal(emoji.slug, 'project--77777777');
  const long = await insert('88888888-8888-4888-8888-888888888888', 'а'.repeat(63) + ' б', null);
  assert.equal(long.slug, 'a'.repeat(63));
  await db.query('UPDATE docgrid_live.workspace_projects SET name=$1 WHERE id=$2', ['Renamed', legacy.id]);
  assert.equal((await db.query('SELECT slug FROM docgrid_live.workspace_projects WHERE id=$1', [legacy.id])).rows[0].slug, legacy.slug);
  assert.deepEqual((await db.query('SELECT * FROM docgrid_live.workspace_documents')).rows, documentsBefore);
  const final = (await db.query('SELECT id,slug FROM docgrid_live.workspace_projects')).rows;
  assert.ok(final.every(row => row.slug));
  assert.equal(new Set(final.map(row => row.slug)).size, final.length);
  console.log('PASS rolling-update repair, old/new inserts, omitted slug, stable addresses/UUIDs, collision suffixes, rename, fallback and length');
  console.log('PASS existing project backfill, equal names, prefix collisions, Cyrillic, fallback and data preservation');
 } finally {await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1});

