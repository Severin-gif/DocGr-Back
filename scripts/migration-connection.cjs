function migrationConnection(env=process.env){
 if(!env.DATABASE_URL)throw Error('DATABASE_URL is required to initialize DocGrid');
 let runtime,migration;
 try{runtime=new URL(env.DATABASE_URL);migration=new URL(env.MIGRATION_DATABASE_URL||env.DATABASE_URL);}catch{throw Error('Invalid database connection configuration');}
 const identity=url=>[url.protocol,url.hostname,url.port||'5432',url.pathname].join('|');
 if(identity(runtime)!==identity(migration))throw Error('MIGRATION_DATABASE_URL must target the same PostgreSQL database as DATABASE_URL');
 if(!['postgres:','postgresql:'].includes(migration.protocol))throw Error('PostgreSQL migration connection is required');
 if(runtime.searchParams.get('schema')!=='docgrid_live')throw Error('Fresh schema cutover requires DATABASE_URL with schema=docgrid_live; existing docgrid data will remain archived');
 if(migration.searchParams.has('schema')&&migration.searchParams.get('schema')!=='docgrid_live')throw Error('MIGRATION_DATABASE_URL must use schema=docgrid_live');
 migration.searchParams.set('schema','docgrid_live');return migration.toString();
}
module.exports={migrationConnection};

