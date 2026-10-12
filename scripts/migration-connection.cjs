function migrationConnection(env=process.env){
 if(!env.DATABASE_URL)throw Error('DATABASE_URL is required to initialize DocGrid');
 let runtime,migration;
 try{runtime=new URL(env.DATABASE_URL);migration=new URL(env.MIGRATION_DATABASE_URL||env.DATABASE_URL);}catch{throw Error('Invalid database connection configuration');}
 const identity=url=>[url.protocol,url.hostname,url.port||'5432',url.pathname].join('|');
 if(identity(runtime)!==identity(migration))throw Error('MIGRATION_DATABASE_URL must target the same PostgreSQL database as DATABASE_URL');
 if(!['postgres:','postgresql:'].includes(migration.protocol))throw Error('PostgreSQL migration connection is required');
 migration.searchParams.set('schema','docgrid');return migration.toString();
}
module.exports={migrationConnection};
