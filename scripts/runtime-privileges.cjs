// Only the active schema is touched. Objects remain owned by their migration
// creator (needed for future ALTERs); API credentials get data access only.
const quoteIdentifier = value => '"' + value.replaceAll('"', '""') + '"';
async function provisionRuntimePrivileges(db, runtimeUrl) {
 const role = decodeURIComponent(new URL(runtimeUrl).username);
 if (!role) throw Error('DATABASE_URL must name the runtime role explicitly');
 const target = quoteIdentifier(role);
 await db.query('BEGIN');
 try {
  await db.query(`GRANT USAGE ON SCHEMA docgrid_live TO ${target}`);
  await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA docgrid_live TO ${target}`);
  await db.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA docgrid_live TO ${target}`);
  // Default privileges belong to the role that actually creates future objects.
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA docgrid_live GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${target}`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA docgrid_live GRANT USAGE, SELECT ON SEQUENCES TO ${target}`);
  await db.query('COMMIT');
 } catch (error) { await db.query('ROLLBACK'); throw error; }
}
module.exports = { provisionRuntimePrivileges };
