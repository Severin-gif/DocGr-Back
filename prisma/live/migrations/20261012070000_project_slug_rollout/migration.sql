-- Do not edit the already deployed slug migration. Serialize writes while installing
-- the legacy-writer guard and repairing rows created since the first backfill.
BEGIN;
LOCK TABLE docgrid_live.workspace_projects IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION docgrid_live.project_slug_base(value text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  value := lower(value);
  value := replace(value, 'а', 'a');
  value := replace(value, 'б', 'b');
  value := replace(value, 'в', 'v');
  value := replace(value, 'г', 'g');
  value := replace(value, 'д', 'd');
  value := replace(value, 'е', 'e');
  value := replace(value, 'ё', 'e');
  value := replace(value, 'ж', 'zh');
  value := replace(value, 'з', 'z');
  value := replace(value, 'и', 'i');
  value := replace(value, 'й', 'y');
  value := replace(value, 'к', 'k');
  value := replace(value, 'л', 'l');
  value := replace(value, 'м', 'm');
  value := replace(value, 'н', 'n');
  value := replace(value, 'о', 'o');
  value := replace(value, 'п', 'p');
  value := replace(value, 'р', 'r');
  value := replace(value, 'с', 's');
  value := replace(value, 'т', 't');
  value := replace(value, 'у', 'u');
  value := replace(value, 'ф', 'f');
  value := replace(value, 'х', 'h');
  value := replace(value, 'ц', 'ts');
  value := replace(value, 'ч', 'ch');
  value := replace(value, 'ш', 'sh');
  value := replace(value, 'щ', 'sch');
  value := replace(value, 'ъ', '');
  value := replace(value, 'ы', 'y');
  value := replace(value, 'ь', '');
  value := replace(value, 'э', 'e');
  value := replace(value, 'ю', 'yu');
  value := replace(value, 'я', 'ya');
  value := trim(both '-' from regexp_replace(value, '[^a-z0-9]+', '-', 'g'));
  value := rtrim(left(value, 64), '-');
  RETURN coalesce(nullif(value, ''), 'project');
END $$;


CREATE FUNCTION docgrid_live.assign_missing_project_slug() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base text; candidate text; suffix integer := 0;
BEGIN
  -- Names can change, published addresses cannot. Respect application-assigned slugs.
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := docgrid_live.project_slug_base(NEW.name);
  -- Same allocation lock as DocGridService.createRepository, including old/new overlap.
  PERFORM pg_advisory_xact_lock(hashtext(base)::bigint);
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM docgrid_live.workspace_projects WHERE slug = candidate AND id <> NEW.id) LOOP
    candidate := base || '--' || left(replace(NEW.id::text, '-', ''), 8)
      || CASE WHEN suffix = 0 THEN '' ELSE '-' || suffix::text END;
    suffix := suffix + 1;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_projects_assign_slug
BEFORE INSERT OR UPDATE OF slug ON docgrid_live.workspace_projects
FOR EACH ROW EXECUTE FUNCTION docgrid_live.assign_missing_project_slug();

-- The table lock excludes concurrent inserts. Do not acquire advisory locks here:
-- a live new writer may already hold one while waiting for this table lock.
DO $$
DECLARE project record; base text; candidate text; suffix integer;
BEGIN
  FOR project IN SELECT id, name FROM docgrid_live.workspace_projects WHERE slug IS NULL ORDER BY created_at, id LOOP
    base := docgrid_live.project_slug_base(project.name);
    candidate := base;
    suffix := 0;
    WHILE EXISTS (SELECT 1 FROM docgrid_live.workspace_projects WHERE slug = candidate) LOOP
      candidate := base || '--' || left(replace(project.id::text, '-', ''), 8)
        || CASE WHEN suffix = 0 THEN '' ELSE '-' || suffix::text END;
      suffix := suffix + 1;
    END LOOP;
    UPDATE docgrid_live.workspace_projects SET slug = candidate WHERE id = project.id;
  END LOOP;
END $$;
COMMIT;

