# Safe rollout of persistent project addresses

This follow-up does not edit migration `20261011210000_project_slugs`, UUIDs,
foreign keys or existing non-null slugs. Migration `20261012070000_project_slug_rollout`
installs a permanent PostgreSQL trigger and repairs only missing slugs. The trigger
supports old applications that omit `slug` and new applications that supply it.
Renaming a project does not regenerate its address. The unique index remains the
final constraint; allocation uses the same per-name advisory lock as the API.

## Before production

1. Verify the actual deployed backend/frontend versions and applied migrations;
   this PR does not establish production state. Take a full PostgreSQL backup
   (`pg_dump --format=custom`) and verify restoration into an isolated database.
   Back up original material storage separately if applicable.
2. Rehearse on that restored copy. Record project UUIDs, names, owners, timestamps,
   existing slugs and related document/material IDs. After migration, compare all
   recorded fields and relationships; only formerly null slugs may differ.
3. Run `npm test`, `node scripts/standalone-http-test.cjs --embedded --slugs-only`,
   and the CI PostgreSQL HTTP acceptance. The embedded tests do not validate
   PostgreSQL multi-session lock scheduling. Rehearse concurrent old/new writes
   on real PostgreSQL before rolling production containers.

## Deployment order

1. Prefer one explicit migration job with the new image (`npm run db:migrate`)
   before rolling backend containers. Prisma also runs migrations at container
   startup; do not start the new API if migration fails. Existing applied
   migration checksums must remain unchanged.
2. Apply the original additive slug migration if still pending, then this follow-up.
   The follow-up transaction holds a SHARE ROW EXCLUSIVE table lock while installing
   the trigger and repairing nulls. Reads continue; writes briefly wait. For a
   large repair or long transactions, schedule a short write pause and measure
   rehearsal duration. Backfill avoids advisory locks so a new writer holding an
   allocation lock while awaiting the table cannot deadlock the migration.
3. Roll backend containers. The trigger remains active throughout and after the
   rollout: old instances cannot create another permanently null slug.
4. Keep/deploy frontend PR #77 after backend migrations. Its `projectRouteKey`
   uses `slug || id`, while `resolveProjectKey` resolves a slug from the user's
   authorized inventory and returns the UUID for API requests. The API still
   accepts UUIDs; no backend route or frontend contract changes are required.

## After migration / release

Check (using the deployment database role):

```sql
SELECT count(*) AS missing_slugs FROM docgrid.workspace_projects WHERE slug IS NULL;
SELECT slug, count(*) FROM docgrid.workspace_projects GROUP BY slug HAVING count(*) > 1;
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'docgrid.workspace_projects'::regclass
  AND tgname = 'workspace_projects_assign_slug';
```

Expect zero missing slugs, no duplicates and enabled trigger `O`. Compare the
pre-migration inventory. With a test account, verify project creation by old and
new images, equal names, authorized inventory/Home/overview, `/projects/<slug>`,
previous `/projects/<uuid>` links, and rename stability. Verify another account
cannot discover or access those projects. Remove only the test-account fixtures.

## Rollback

Roll back application images while retaining the additive column, index, helper
functions and trigger. Old writers remain compatible and UUID access survives.
Do not drop slugs or regenerate published addresses. If the migration transaction
fails, its changes roll back atomically; inspect and resolve the Prisma failed
migration before retrying. Restore a backup only after a separate approved recovery
procedure; it would discard writes made since the backup.
