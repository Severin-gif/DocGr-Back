// A separate schema also gives DocGrid its own Prisma migration ledger.
const { spawnSync } = require('node:child_process');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to initialize DocGrid'); process.exit(1);
}
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', 'docgrid');
const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.toString() },
});
process.exit(result.status ?? 1);
