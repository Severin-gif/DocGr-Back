# Migration database role

A successful image build followed by `must be owner of table docgrid_branch_documents` means the connection role cannot alter existing tables. GRANT ALL on a table does not grant ownership privileges needed for ALTER TABLE.

Set `MIGRATION_DATABASE_URL` in the Back application's runtime environment to a PostgreSQL connection for the owner of the existing `docgrid` tables, a role allowed to act as that owner, or the database administrator with the necessary privileges. It must point to the same host, port and database as `DATABASE_URL`; only migration credentials and connection parameters may differ. Keep `DATABASE_URL` for normal API traffic. No credentials belong in Git or logs.

The startup script uses `MIGRATION_DATABASE_URL` for both the DOCX recovery and Prisma resolve/deploy. After migrations, the API process continues to use the original `DATABASE_URL`. If the variable is absent, migration startup uses `DATABASE_URL` as before. Setting the variable to the same limited account does not fix the ownership error.

Read-only diagnostic queries in the PostgreSQL console:

```sql
SELECT current_user, session_user;
SELECT n.nspname AS schema_name, c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='docgrid' AND c.relkind IN ('r','p')
ORDER BY c.relname;
```

Do not delete migration records, reset the database, or skip startup migrations to bypass this failure. A redeploy without correcting the migration role repeats the ownership error. After setting the owner connection, deploy the updated Back image and check that migrations and the container healthcheck succeed.
