const MIGRATION='20261008174500_document_docx_structure';
const CHECK=`(docx_bytes IS NULL AND docx_sha256 IS NULL AND format_version IS NULL) OR (docx_bytes IS NOT NULL AND docx_sha256 IS NOT NULL AND format_version IS NOT NULL)`;
async function recoverDocxMigration(db) {
 if(!(await db.query("SELECT to_regclass('docgrid_live._prisma_migrations') AS ledger")).rows[0].ledger)return false;
 const failed=await db.query('SELECT id FROM docgrid_live._prisma_migrations WHERE migration_name=$1 AND finished_at IS NULL AND rolled_back_at IS NULL',[MIGRATION]);
 if(!failed.rows.length)return false;
 await db.query('BEGIN');
 try {
  // Repair only the known additive migration. Never rewrite document data.
  await db.query(`CREATE TEMP TABLE dg_expected_docx_recovery(docx_bytes BYTEA,docx_sha256 CHAR(64),format_version TEXT,CONSTRAINT dg_expected_snapshot CHECK (${CHECK})) ON COMMIT DROP`);
  const expected=(await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='pg_temp.dg_expected_docx_recovery'::regclass AND conname='dg_expected_snapshot'")).rows[0].definition;
  for(const [table,constraint] of [['docgrid_branch_documents','dg_branch_docx_snapshot'],['docgrid_commits','dg_commit_docx_snapshot']]) {
   if(!(await db.query('SELECT to_regclass($1) AS relation',['docgrid_live.'+table])).rows[0].relation)throw Error('DOCX recovery refused: missing table '+table);
   await db.query(`ALTER TABLE docgrid_live.${table} ADD COLUMN IF NOT EXISTS docx_bytes BYTEA,ADD COLUMN IF NOT EXISTS docx_sha256 CHAR(64),ADD COLUMN IF NOT EXISTS format_version TEXT`);
   const columns=(await db.query("SELECT attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS required FROM pg_attribute WHERE attrelid=$1::regclass AND NOT attisdropped AND attname IN ('docx_bytes','docx_sha256','format_version')",['docgrid_live.'+table])).rows;
   const types={docx_bytes:'bytea',docx_sha256:'character(64)',format_version:'text'};
   if(columns.length!==3||columns.some(c=>c.type!==types[c.name]||c.required))throw Error('DOCX recovery refused: incompatible columns in '+table);
   const constraints=(await db.query('SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2',['docgrid_live.'+table,constraint])).rows;
   if(constraints.length&&(constraints[0].contype!=='c'||constraints[0].definition.replace(/ NOT VALID$/,'')!==expected))throw Error('DOCX recovery refused: incompatible constraint '+constraint);
   if(!constraints.length)await db.query(`ALTER TABLE docgrid_live.${table} ADD CONSTRAINT ${constraint} CHECK (${CHECK}) NOT VALID`);
   // Fail on inconsistent snapshots; do not modify them to pass validation.
   await db.query(`ALTER TABLE docgrid_live.${table} VALIDATE CONSTRAINT ${constraint}`);
  }
  await db.query('COMMIT');return true;
 }catch(error){await db.query('ROLLBACK');throw error;}
}
module.exports={MIGRATION,recoverDocxMigration};

