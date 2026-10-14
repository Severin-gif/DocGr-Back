const assert = require('node:assert/strict');
module.exports = async ({call, jwt, db, databaseUrl}) => {
  const create = () => call('/api/docgrid/repositories', 'POST', {name:'Тимаева'}, jwt('owner'), 201);
  const [first, second] = await Promise.all([create(), create()]);
  assert.notEqual(first.slug, second.slug);
  assert.ok([first.slug, second.slug].includes('timaeva'));
  assert.match(first.slug, /^timaeva(?:--[0-9a-f]{8})?$/);
  assert.match(second.slug, /^timaeva(?:--[0-9a-f]{8})?$/);
  const prefix = '/api/docgrid/repositories/' + first.id;
  const renamed = await call(prefix, 'PUT', {name:'Новое название'}, jwt('owner'));
  assert.equal(renamed.slug, first.slug);
  const overview = await call(prefix + '/overview');
  assert.equal(overview.repository.slug, first.slug);
  assert.equal(overview.repository.name, 'Новое название');
  assert.equal((await call('/api/docgrid/repositories')).find(p => p.id === first.id).slug, first.slug);
  assert.equal((await call('/api/docgrid/home')).repositories.find(p => p.id === first.id).slug, first.slug);
  assert.ok(!(await call('/api/docgrid/repositories','GET',undefined,jwt('stranger'))).some(p => p.slug === first.slug));
  await call(prefix + '/overview','GET',undefined,jwt('stranger'),404);
  // A pre-slug application writes the same table without the new column.
  const [legacy] = await db.$queryRaw`INSERT INTO docgrid_live.workspace_projects(owner_id,name)
    SELECT owner_id,'Тимаева' FROM docgrid_live.workspace_projects WHERE id=${first.id}::uuid RETURNING id,slug`;
  assert.ok(legacy.slug);
  assert.notEqual(legacy.slug, first.slug);
  assert.notEqual(legacy.slug, second.slug);
  const inventory = await call('/api/docgrid/repositories');
  assert.equal(inventory.find(p => p.id === legacy.id).slug, legacy.slug);
  assert.equal((await call('/api/docgrid/repositories/' + legacy.id + '/overview')).repository.slug, legacy.slug);
  assert.equal((await call('/api/docgrid/home')).repositories.find(p => p.id === legacy.id).slug, legacy.slug);
  assert.ok(!(await call('/api/docgrid/repositories','GET',undefined,jwt('stranger'))).some(p => p.id === legacy.id));
  if (databaseUrl) {
    // Separate PostgreSQL connection: exercise old/new writers, not a serialized Prisma pool.
    const { Client } = require('pg');
    const old = new Client({connectionString: databaseUrl});
    await old.connect();
    try {
      const createNew = () => call('/api/docgrid/repositories', 'POST', {name:'Mixed rollout'}, jwt('owner'), 201);
      const createOld = async () => (await old.query(
        "INSERT INTO docgrid_live.workspace_projects(owner_id,name) SELECT owner_id,'Mixed rollout' FROM docgrid_live.workspace_projects WHERE id=$1 RETURNING id,slug", [first.id],
      )).rows[0];
      const mixed = await Promise.all([createNew(), createOld(), createNew(), createOld()]);
      assert.equal(new Set(mixed.map(p => p.slug)).size, mixed.length);
      assert.ok(mixed.every(p => p.slug));
      const authorized = await call('/api/docgrid/repositories');
      for (const p of mixed) assert.equal(authorized.find(row => row.id === p.id).slug, p.slug);
      console.log('PASS real PostgreSQL concurrent old/new writers allocate unique persistent slugs');
    } finally { await old.end(); }
  }
  console.log('PASS legacy-container insert gains slug visible in authorized inventory, overview and Home');
  console.log('PASS persistent project slugs, concurrent equal names, UUID access, rename stability and authorization');
};

