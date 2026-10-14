# Fresh start inside the existing DocGrid database

This release switches the application, raw SQL, Prisma client, migrations,
DOCX recovery and backups to `docgrid_live`. It is a fresh start: old users,
projects and documents are not copied or exposed by the new application.
The legacy `docgrid` schema is left intact, including its objects, owners,
data and failed migration ledger. No postgres credentials are required.

Before deploying, connect to database `DocGrid` as `Slava` and execute:

```sql
CREATE SCHEMA docgrid_live AUTHORIZATION "Slava";
```

If the schema already exists, inspect its owner and contents instead of
dropping or overwriting it. Creation errors must be resolved before deployment.

Keep the same host, port, database, username and password. Explicitly add
`schema=docgrid_live` to both `DATABASE_URL` and `MIGRATION_DATABASE_URL`.
Use `?schema=docgrid_live` when there are no existing URL parameters, otherwise
append `&schema=docgrid_live`. Startup rejects URLs without the explicit new
runtime schema to prevent an accidental fresh start on an unconfigured deployment.
Configure any separately deployed workers with this release and the same schema.

Run the normal deployment. All 23 migrations use the independent ledger
`docgrid_live._prisma_migrations`; the old failed ledger is never repaired or
resolved. The active Prisma schema and migration directory are under
`prisma/live/`. The original `prisma/schema.prisma` and `prisma/migrations/`
remain archived and must not be used to generate the active client.

After deployment, verify `/ready`, register again, create a project, upload
and download a document. Confirm owners with:

```sql
SELECT schemaname, tableowner, count(*)
FROM pg_tables
WHERE schemaname IN ('docgrid', 'docgrid_live')
GROUP BY schemaname, tableowner
ORDER BY schemaname, tableowner;
```

Active backups include only `docgrid_live`. Preserve a separate backup of the
legacy schema if its data is still needed. S3 objects are not deleted by this
cutover, but old project links and shares are not available in the new application.
Rollback requires the previous application image and its previous connection
configuration; changing only the URL cannot switch this generated Prisma client.

Validation: `npm run test:fresh-schema` runs two real Prisma migration startups,
project creation and upload/download beside legacy-owner tables and a failed old
ledger, then verifies the legacy rows, columns, owners and ledger are unchanged.
