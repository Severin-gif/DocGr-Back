require("reflect-metadata");
const fs = require("fs"),
  path = require("path"),
  ts = require("typescript"),
  assert = require("node:assert/strict");
require.extensions[".ts"] = function (module, file) {
  module._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    file,
  );
};
const { PGlite } = require("@electric-sql/pglite");
const root = process.cwd();
const { DocGridService } = require(
  root + "/src/modules/docgrid/docgrid.service.ts",
);
(async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(
    `CREATE SCHEMA docgrid; SET search_path=docgrid; CREATE TABLE docgrid."User"(id TEXT PRIMARY KEY,email TEXT); CREATE TABLE docgrid.workspace_projects(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner_id TEXT REFERENCES docgrid."User"(id),name TEXT,description TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now()); CREATE TABLE docgrid.workspace_documents(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),project_id UUID REFERENCES docgrid.workspace_projects(id),title TEXT,path TEXT,content TEXT,version INT DEFAULT 1,updated_at TIMESTAMPTZ DEFAULT now()); CREATE TABLE docgrid.workspace_document_versions(document_id UUID REFERENCES docgrid.workspace_documents(id),version INT,content TEXT,author_id TEXT,message TEXT,PRIMARY KEY(document_id,version)); INSERT INTO docgrid."User" VALUES('owner','owner@test'),('editor','editor@test'),('reader','reader@test'),('reviewer','reviewer@test'),('stranger','stranger@test');`,
  );
  await pg.exec(
    fs.readFileSync(
      "prisma/migrations/20260918213000_add_docgrid_gitlaw/migration.sql",
      "utf8",
    ),
  );
  await pg.exec(
    fs.readFileSync(
      "prisma/migrations/20260921170000_docgrid_core/migration.sql",
      "utf8",
    ),
  );
  await pg.exec(fs.readFileSync("prisma/migrations/20260924220000_docgrid_material_storage/migration.sql", "utf8"));
  function adapter(client) {
    const query = async (strings, ...values) =>
      client.query(
        strings.reduce((s, v, i) => s + (i ? "$" + i : "") + v, ""),
        values,
      );
    const db = {
      $queryRaw: async (s, ...v) => (await query(s, ...v)).rows,
      $executeRaw: async (s, ...v) => (await query(s, ...v)).affectedRows,
    };
    db.$transaction = (fn) => client.transaction((tx) => fn(adapter(tx)));
    db.workspaceProject = {
      create: async ({ data: d }) =>
        (
          await client.query(
            'INSERT INTO docgrid.workspace_projects(owner_id,name,description) VALUES($1,$2,$3) RETURNING id,name,description,created_at AS "createdAt",updated_at AS "updatedAt"',
            [d.ownerId, d.name, d.description],
          )
        ).rows[0],
    };
    db.workspaceDocument = {
      create: async ({ data: d }) => {
        const r = (
          await client.query(
            'INSERT INTO docgrid.workspace_documents(project_id,title,path,content) VALUES($1,$2,$3,$4) RETURNING id,project_id AS "projectId",title,path,content,version,updated_at AS "updatedAt"',
            [d.projectId, d.title, d.path, d.content],
          )
        ).rows[0];
        const v = d.versions.create;
        await client.query(
          "INSERT INTO docgrid.workspace_document_versions VALUES($1,$2,$3,$4,$5)",
          [r.id, v.version, v.content, v.authorId, v.message],
        );
        return r;
      },
    };
    return db;
  }
  const service = new DocGridService(adapter(pg));
  const project = await service.createRepository("owner", { name: "Case" });
  const doc = await service.createArtifact("owner", project.id, {
    title: "Agreement",
    content: "a\nb\nc",
  });
  const main = project.mainBranchId;
  const a = await service.createBranch("owner", project.id, { name: "Alice" }),
    b = await service.createBranch("owner", project.id, { name: "Bob" });
  await service.saveBranchDocument("owner", a.id, doc.id, {
    revision: 1,
    content: "A\nb\nc",
    message: "Alice",
  });
  await service.saveBranchDocument("owner", b.id, doc.id, {
    revision: 1,
    content: "a\nb\nC",
    message: "Bob",
  });
  const ra = await service.createReview("owner", {
    projectId: project.id,
    sourceBranchId: a.id,
    targetBranchId: main,
    title: "A",
  });
  await service.mergeReview("owner", ra.id);
  const rb = await service.createReview("owner", {
    projectId: project.id,
    sourceBranchId: b.id,
    targetBranchId: main,
    title: "B",
  });
  await service.mergeReview("owner", rb.id);
  assert.equal(
    (await service.listBranchDocuments("owner", main))[0].content,
    "A\nb\nC",
  );
  console.log("PASS independent edits survive PR merges");
  const c = await service.createBranch("owner", project.id, { name: "Carol" }),
    d = await service.createBranch("owner", project.id, { name: "Dan" });
  const rev = (await service.listBranchDocuments("owner", main))[0].revision;
  await service.saveBranchDocument("owner", c.id, doc.id, {
    revision: rev,
    content: "X\nb\nC",
    message: "c",
  });
  await service.saveBranchDocument("owner", d.id, doc.id, {
    revision: rev,
    content: "Y\nb\nC",
    message: "d",
  });
  const rc = await service.createReview("owner", {
    projectId: project.id,
    sourceBranchId: c.id,
    targetBranchId: main,
    title: "C",
  });
  await service.mergeReview("owner", rc.id);
  const rd = await service.createReview("owner", {
    projectId: project.id,
    sourceBranchId: d.id,
    targetBranchId: main,
    title: "D",
  });
  await assert.rejects(
    () => service.mergeReview("owner", rd.id),
    (e) => e.getStatus() === 409,
  );
  assert.equal(
    (await service.listReviews("owner", project.id)).find((r) => r.id === rd.id)
      .status,
    "CONFLICT",
  );
  assert.equal(
    (await service.listBranchDocuments("owner", main))[0].content,
    "X\nb\nC",
  );
  console.log("PASS conflict persists without overwriting target");
  let source = (await service.listBranchDocuments("owner", d.id))[0],
    target = (await service.listBranchDocuments("owner", main))[0];
  await assert.rejects(
    () =>
      service.saveBranchDocument("owner", d.id, doc.id, {
        revision: source.revision,
        content: "Z\nb\nC",
        message: "resolve",
        targetBranchId: main,
        targetRevision: 1,
      }),
    (e) => e.getStatus() === 409,
  );
  await service.saveBranchDocument("owner", d.id, doc.id, {
    revision: source.revision,
    content: "Z\nb\nC",
    message: "resolve",
    targetBranchId: main,
    targetRevision: target.revision,
  });
  await service.refreshReview("owner", rd.id);
  await service.mergeReview("owner", rd.id);
  assert.equal(
    (await service.listBranchDocuments("owner", main))[0].content,
    "Z\nb\nC",
  );
  console.log(
    "PASS revision-bound manual conflict resolution and refreshed PR",
  );
  await assert.rejects(
    () =>
      service.saveBranchDocument("owner", main, doc.id, {
        revision: target.revision,
        content: "bad",
        message: "direct",
      }),
    (e) => e.getStatus() === 403,
  );
  await service.setMember("owner", project.id, "reader@test", "READER");
  await service.setMember("owner", project.id, "editor@test", "EDITOR");
  await service.setMember("owner", project.id, "reviewer@test", "REVIEWER");
  assert.equal((await service.listBranchDocuments("reader", main)).length, 1);
  await assert.rejects(() =>
    service.createBranch("reader", project.id, { name: "not allowed" }),
  );
  await assert.rejects(() => service.listBranchDocuments("stranger", main));
  const eb = await service.createBranch("editor", project.id, {
    name: "Editor",
  });
  const er = (await service.listBranchDocuments("editor", eb.id))[0];
  await service.saveBranchDocument("editor", eb.id, doc.id, {
    revision: er.revision,
    content: "ZZ\nb\nC",
    message: "editor",
  });
  const ep = await service.createReview("editor", {
    projectId: project.id,
    sourceBranchId: eb.id,
    targetBranchId: main,
    title: "editor",
  });
  await assert.rejects(() => service.mergeReview("editor", ep.id));
  await service.mergeReview("reviewer", ep.id);
  console.log("PASS owner/editor/reviewer/reader isolation and protected main");
  const file = await service.uploadMaterial(
    "owner",
    project.id,
    {
      originalname: "proof.txt",
      mimetype: "text/plain",
      buffer: Buffer.from("Evidence"),
    },
    "/Evidence",
  );
  const original = await service.material("reader", project.id, file.id);
  assert.equal(Buffer.from(original.bytes).toString(), "Evidence");
  await assert.rejects(() =>
    pg.query("UPDATE docgrid_materials SET bytes=$1 WHERE id=$2", [
      Buffer.from("altered"),
      file.id,
    ]),
  );
  await service.trashFile("owner", project.id, file.id, "material", false);
  await assert.rejects(() => service.material("owner", project.id, file.id));
  await service.trashFile("owner", project.id, file.id, "material", true);
  assert.equal(
    Buffer.from(
      (await service.material("owner", project.id, file.id)).bytes,
    ).toString(),
    "Evidence",
  );
  await service.trashFile("owner", project.id, doc.id, "document", false);
  assert.equal((await service.listBranchDocuments("owner", main)).length, 0);
  await service.trashFile("owner", project.id, doc.id, "document", true);
  assert.equal((await service.listBranchDocuments("owner", main)).length, 1);
  console.log("PASS immutable originals, material/document trash and restore");
  assert.ok((await service.activity("owner", project.id, 100)).length > 10);
  const snapshot = await pg.dumpDataDir();
  const pg2 = new PGlite({ loadDataDir: snapshot });
  await pg2.waitReady;
  assert.equal(
    (await pg2.query("SELECT count(*)::int n FROM docgrid.docgrid_materials")).rows[0]
      .n,
    1,
  );
  await pg2.close();
  console.log("PASS persisted database snapshot roundtrip");
  const moved = await service.relocateMaterial('owner',project.id,file.id,{sha256:file.sha256,fromPath:'/Evidence',path:'/Case/Nested'});
  assert.equal(moved.id,file.id);
  assert.equal((await service.material('reader',project.id,file.id)).bytes.toString(),'Evidence');
  const tree = await service.files('owner',project.id);
  assert.ok(tree.folders.some(folder=>folder.path==='/Case'));
  assert.ok(tree.folders.some(folder=>folder.path==='/Case/Nested'));
  assert.equal((await service.relocateMaterial('owner',project.id,file.id,{sha256:file.sha256,fromPath:'/Evidence',path:'/Case/Nested'})).id,file.id);
  await assert.rejects(()=>service.relocateMaterial('owner',project.id,file.id,{sha256:file.sha256,fromPath:'/Evidence',path:'/Wrong'}),e=>e.getStatus()===409);
  await assert.rejects(()=>service.relocateMaterial('reader',project.id,file.id,{sha256:file.sha256,fromPath:'/Case/Nested',path:'/Wrong'}),e=>e.getStatus()===404);
  await assert.rejects(()=>service.relocateMaterial('stranger',project.id,file.id,{sha256:file.sha256,fromPath:'/Case/Nested',path:'/Wrong'}),e=>e.getStatus()===404);
  await assert.rejects(()=>service.relocateMaterial('owner',project.id,file.id,{sha256:'0'.repeat(64),fromPath:'/Case/Nested',path:'/Wrong'}),e=>e.getStatus()===409);
  const replay = await service.uploadMaterial('owner',project.id,{originalname:'proof.txt',mimetype:'text/plain',buffer:Buffer.from('Evidence')},'/Case/Nested');
  assert.equal(replay.id,file.id);assert.equal(replay.reused,true);
  await assert.rejects(()=>service.uploadMaterial('owner',project.id,{originalname:'proof.txt',mimetype:'text/plain',buffer:Buffer.from('Modified')},'/Case/Nested'),e=>e.getStatus()===409);
  await assert.rejects(()=>service.uploadMaterial('owner',project.id,{originalname:'proof.txt',mimetype:'text/plain',buffer:Buffer.from('Evidence')},'/../bad'),e=>e.getStatus()===400);
  console.log('PASS nested folder restoration, unchanged identity, CAS retries, ACL and path conflicts');

  const large = Buffer.alloc(11*1024*1024,7);
  const bigFile = await service.uploadMaterial('owner',project.id,{originalname:'large.bin',mimetype:'application/octet-stream',buffer:large},'/Large');
  assert.equal((await service.material('owner',project.id,bigFile.id)).bytes.length,large.length);
  const { verifyMaterialBytes } = require(root+'/src/modules/docgrid/docgrid-material-storage.service.ts');
  const { createHash } = require('node:crypto');
  const objects = new Map();let writes=0;
  const storage = {
    enabled:true,
    async store(projectId,bytes,hash) { const key=`docgrid/materials/${projectId}/${hash}`; objects.set(key,Buffer.from(bytes));writes++;return key; },
    async read(row) { return verifyMaterialBytes(row,row.storage_key ? objects.get(row.storage_key) : Buffer.from(row.bytes)); },
  };
  const s3Service = new DocGridService(adapter(pg),storage);
  const s3file = await s3Service.uploadMaterial('owner',project.id,{originalname:'private.txt',mimetype:'text/plain',buffer:Buffer.from('Private original')},'/S3');
  const external = (await pg.query('SELECT * FROM docgrid.docgrid_materials WHERE id=$1',[s3file.id])).rows[0];
  assert.equal(external.bytes,null);assert.ok(external.storage_key);assert.equal(external.byte_size,16);
  assert.equal((await s3Service.material('reader',project.id,s3file.id)).bytes.toString(),'Private original');
  const beforeMigration = (await service.files('owner',project.id)).materials.find(item=>item.id===bigFile.id);
  const migrationKey = await storage.store(project.id,large,bigFile.sha256);
  await pg.query('UPDATE docgrid.docgrid_materials SET storage_key=$1 WHERE id=$2',[migrationKey,bigFile.id]);
  // Verify the real backing object, even while a database mirror is retained.
  assert.equal((await s3Service.material('owner',project.id,bigFile.id)).bytes.length,large.length);
  await pg.query('UPDATE docgrid.docgrid_materials SET bytes=NULL WHERE id=$1',[bigFile.id]);
  const afterMigration = (await s3Service.files('owner',project.id)).materials.find(item=>item.id===bigFile.id);
  assert.deepEqual(afterMigration,beforeMigration);
  assert.equal(createHash('sha256').update((await s3Service.material('owner',project.id,bigFile.id)).bytes).digest('hex'),bigFile.sha256);
  await assert.rejects(()=>pg.query('UPDATE docgrid.docgrid_materials SET storage_key=$1 WHERE id=$2',['docgrid/materials/other',bigFile.id]),/immutable/);
  await assert.rejects(()=>pg.query('UPDATE docgrid.docgrid_materials SET byte_size=1 WHERE id=$1',[bigFile.id]),/immutable/);
  objects.set(migrationKey,Buffer.from('tampered'));
  await assert.rejects(()=>s3Service.material('owner',project.id,bigFile.id),e=>e.getResponse().code==='SOURCE_INTEGRITY_FAILED');
  const failingStorage = new DocGridService(adapter(pg),{...storage,store:async()=>{throw Error('storage unavailable');}});
  const count = (await service.files('owner',project.id)).materials.length;
  await assert.rejects(()=>failingStorage.uploadMaterial('owner',project.id,{originalname:'failed.txt',mimetype:'text/plain',buffer:Buffer.from('Fail')},'/S3'),/storage unavailable/);
  assert.equal((await service.files('owner',project.id)).materials.length,count);
  assert.equal((await s3Service.uploadMaterial('owner',project.id,{originalname:'private.txt',mimetype:'text/plain',buffer:Buffer.from('Private original')},'/S3')).id,s3file.id);
  assert.equal(writes,2);
  console.log('PASS >10 MiB database upload, S3 originals, verified migration, stable metadata, immutable pointers, tamper/failure rejection');
  const badPdf = Buffer.from('%PDF-1.4\ninvalid');
  const badUpload = await s3Service.uploadMaterial('owner',project.id,{originalname:'broken.pdf',mimetype:'application/pdf',buffer:badPdf},'/S3');
  assert.equal(badUpload.extractionStatus,'UNREAD');
  assert.deepEqual((await s3Service.material('reader',project.id,badUpload.id)).bytes,badPdf);
  const badStored = (await pg.query('SELECT bytes,storage_key,extracted_text FROM docgrid.docgrid_materials WHERE id=$1',[badUpload.id])).rows[0];
  assert.equal(badStored.bytes,null);assert.ok(badStored.storage_key);assert.equal(badStored.extracted_text,'');
  console.log('PASS PDF parser failure still stores exact immutable original with UNREAD status');
  await pg.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


