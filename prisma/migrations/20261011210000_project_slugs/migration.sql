ALTER TABLE docgrid.workspace_projects ADD COLUMN slug varchar(120);
CREATE UNIQUE INDEX workspace_projects_slug_key ON docgrid.workspace_projects(slug);

-- Temporary helper is used only during this additive migration.
CREATE FUNCTION pg_temp.docgrid_project_slug(value text) RETURNS text LANGUAGE plpgsql AS $$
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

DO $$
DECLARE project record; base text; candidate text; suffix integer;
BEGIN
  FOR project IN SELECT id, name FROM docgrid.workspace_projects WHERE slug IS NULL ORDER BY created_at, id LOOP
    base := pg_temp.docgrid_project_slug(project.name);
    candidate := base;
    suffix := 0;
    WHILE EXISTS (SELECT 1 FROM docgrid.workspace_projects WHERE slug = candidate) LOOP
      candidate := base || '--' || left(replace(project.id::text, '-', ''), 8) || CASE WHEN suffix = 0 THEN '' ELSE '-' || suffix::text END;
      suffix := suffix + 1;
    END LOOP;
    UPDATE docgrid.workspace_projects SET slug = candidate WHERE id = project.id;
  END LOOP;
END $$;
