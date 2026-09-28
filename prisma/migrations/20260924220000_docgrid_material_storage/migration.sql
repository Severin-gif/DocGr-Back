-- Replace the legacy unnamed 10 MiB CHECK (PostgreSQL's generated name).
ALTER TABLE docgrid.docgrid_materials DROP CONSTRAINT docgrid_materials_bytes_check;
-- Original identity and digest remain unchanged when its backing storage moves.
ALTER TABLE docgrid.docgrid_materials ADD COLUMN byte_size INTEGER;
ALTER TABLE docgrid.docgrid_materials ADD COLUMN storage_key TEXT;
UPDATE docgrid.docgrid_materials SET byte_size=octet_length(bytes);
ALTER TABLE docgrid.docgrid_materials ALTER COLUMN byte_size SET NOT NULL;
ALTER TABLE docgrid.docgrid_materials ALTER COLUMN bytes DROP NOT NULL;
ALTER TABLE docgrid.docgrid_materials ADD CONSTRAINT docgrid_material_payload CHECK (
 byte_size BETWEEN 1 AND 524288000 AND
 (bytes IS NOT NULL OR storage_key IS NOT NULL) AND
 (bytes IS NULL OR octet_length(bytes)=byte_size) AND
 (storage_key IS NULL OR storage_key LIKE 'docgrid/materials/%')
);
CREATE FUNCTION docgrid.docgrid_material_size() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.byte_size := COALESCE(NEW.byte_size, octet_length(NEW.bytes));
 RETURN NEW;
END $$;
CREATE TRIGGER docgrid_material_size BEFORE INSERT ON docgrid.docgrid_materials FOR EACH ROW EXECUTE FUNCTION docgrid.docgrid_material_size();

CREATE OR REPLACE FUNCTION docgrid.docgrid_immutable_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR (OLD.storage_key IS NOT NULL AND NEW.storage_key IS DISTINCT FROM OLD.storage_key)
    OR (NEW.bytes IS DISTINCT FROM OLD.bytes AND NOT
        (OLD.bytes IS NOT NULL AND NEW.bytes IS NULL AND NEW.storage_key IS NOT NULL)) THEN
  RAISE EXCEPTION 'DocGrid source material is immutable';
 END IF;
 RETURN NEW;
END $$;

