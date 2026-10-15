const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
assert.ok(Prisma.dmmf.datamodel.models.length > 0);
const generated = require('node:fs').readFileSync(require('node:path').join(require.resolve('.prisma/client/package.json'), '..', 'schema.prisma'), 'utf8');
assert.ok(!generated.includes('@@schema("docgrid")'));
assert.equal((generated.match(/@@schema\("docgrid_live"\)/g) || []).length, Prisma.dmmf.datamodel.models.length + Prisma.dmmf.datamodel.enums.length);
console.log('PASS installed Prisma client targets docgrid_live for every model');
