/* Synthetic acceptance using the real domain services and PostgreSQL SQL.
 * Default: embedded PostgreSQL (PGlite). CI: isolated real PostgreSQL via
 * ASTRA_TEST_DATABASE_URL, which must name an EMPTY astra_test* database.
 * No model, real case files, production DB or external storage is used.
 */
require('reflect-metadata');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true },
}).outputText, file);
const { AgentOAuthCodeStore } = require('../src/modules/docgrid/agent-oauth.controller.ts');
const { AstraService } = require('../src/modules/docgrid/astra/astra.service.ts');
const { AstraSourcesService, ASTRA_SOURCE_TOOLS } = require('../src/modules/docgrid/astra/astra-sources.service.ts');
const { AstraWorkflowService, ASTRA_WORKFLOW_TOOLS } = require('../src/modules/docgrid/astra/astra-workflow.service.ts');
const { DocumentFileService } = require('../src/modules/document-workflow/document-file.service.ts');
const { AstraUploadService, ASTRA_UPLOAD_TOOLS } = require('../src/modules/docgrid/astra/astra-upload.service.ts');
const sha = v => createHash('sha256').update(v).digest('hex');

// Thin Prisma-shaped adapter. SQL remains real; no domain method is mocked.
const maps = {
  documentTask: ['document_tasks', { ownerId:'owner_id', documentId:'document_id', planRevision:'plan_revision', confirmedAt:'confirmed_at', resultVersion:'result_version', completedAt:'completed_at', updatedAt:'updated_at' }],
  preparedLegalDocument: ['prepared_legal_documents', { ownerId:'owner_id', currentVersion:'current_version', nextVersion:'next_version', updatedAt:'updated_at' }],
  documentVersion: ['document_versions', { documentId:'document_id', structuredContent:'structured_content', plainText:'plain_text', sourceVersionId:'source_version_id', changeRequest:'change_request', createdBy:'created_by', readyAt:'ready_at', docxObjectKey:'docx_object_key', pdfObjectKey:'pdf_object_key', docxSize:'docx_size', pdfSize:'pdf_size', errorMessage:'error_message', createdAt:'created_at' }],
};
function adapter(client, transact) {
  const query = (s, ...v) => client.query(s.reduce((sql, part, i) => sql + (i ? '$'+i : '') + part, ''), v);
  const db = { $queryRaw: async(s,...v)=>(await query(s,...v)).rows, $executeRaw: async(s,...v)=>{const r=await query(s,...v);return r.affectedRows??r.rowCount;}, $executeRawUnsafe: s=>client.query(s) };
  if (transact) db.$transaction = fn => transact(c=>fn(adapter(c)));
  for (const [name,[table, fields]] of Object.entries(maps)) {
    const col = k => '"'+(fields[k]||k)+'"';
    const row = r => r && Object.fromEntries(Object.entries(r).map(([k,v])=>[Object.keys(fields).find(f=>fields[f]===k)||k,v]));
    const value = (k,v) => ['structuredContent','attachments','plan'].includes(k) ? JSON.stringify(v) : v;
    const where = (input, params) => Object.entries(input||{}).flatMap(([k,v])=> k==='documentId_version' ? Object.entries(v) : [[k,v]]).map(([k,v])=> {
      if(v&&typeof v==='object'&&'lt' in v){params.push(v.lt);return col(k)+'<$'+params.length;}
      params.push(v);return col(k)+'=$'+params.length;
    }).join(' AND ') || 'TRUE';
    const model = {
      create: async({data})=>{const keys=Object.keys(data),values=keys.map(k=>value(k,data[k]));return row((await client.query(`INSERT INTO docgrid.${table} (${keys.map(col).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values)).rows[0]);},
      update: async({where:w,data})=>{const keys=Object.keys(data),values=keys.map(k=>value(k,data[k]));const set=keys.map((k,i)=>col(k)+'=$'+(i+1)).join(',');const condition=where(w,values);return row((await client.query(`UPDATE docgrid.${table} SET ${set} WHERE ${condition} RETURNING *`,values)).rows[0]);},
      updateMany: async({where:w,data})=>{const keys=Object.keys(data),values=keys.map(k=>value(k,data[k]));const set=keys.map((k,i)=>col(k)+'=$'+(i+1)).join(',');const condition=where(w,values);const r=await client.query(`UPDATE docgrid.${table} SET ${set} WHERE ${condition}`,values);return {count:r.affectedRows??r.rowCount};},
      findUnique: async({where:w})=>{const values=[];const condition=where(w,values);return row((await client.query(`SELECT * FROM docgrid.${table} WHERE ${condition} LIMIT 1`,values)).rows[0])||null;},
      findMany: async({where:w,orderBy,take=100})=>{const values=[];const condition=where(w,values);const order=Object.entries(orderBy||{}).map(([k,v])=>col(k)+' '+(v==='desc'?'DESC':'ASC')).join(',');return (await client.query(`SELECT * FROM docgrid.${table} WHERE ${condition}${order?' ORDER BY '+order:''} LIMIT ${Number(take)}`,values)).rows.map(row);},
    }; model.findFirst=model.findUnique; db[name]=model;
  }
  return db;
}

(async()=>{
  let database, close, transact, mode;
  if(process.env.ASTRA_TEST_DATABASE_URL){
    const url = new URL(process.env.ASTRA_TEST_DATABASE_URL);
    assert.match(url.pathname,/^\/astra_test[a-z0-9_-]*$/i,'Only an isolated astra_test database is accepted');
    const { Pool }=require('pg'); const pool=new Pool({connectionString:url.toString(),max:6});
    database=pool;close=()=>pool.end();mode='PostgreSQL (separate connections)';
    transact=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  } else {
    const {PGlite}=require('@electric-sql/pglite');database=new PGlite();await database.waitReady;close=()=>database.close();mode='PGlite (embedded PostgreSQL)';transact=fn=>database.transaction(fn);
  }
  const exec = sql => database.exec ? database.exec(sql) : database.query(sql);
  try {
    const existing=await database.query("SELECT to_regclass('docgrid.workspace_projects') AS existing");
    assert.equal(existing.rows[0].existing,null,'Acceptance database must be empty; no existing data is removed');
    await exec(`CREATE SCHEMA docgrid; SET search_path=docgrid; CREATE TABLE docgrid."User"(id TEXT PRIMARY KEY,email TEXT);
      CREATE TABLE docgrid.workspace_projects(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner_id TEXT REFERENCES docgrid."User"(id),name TEXT,description TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE docgrid.workspace_documents(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),project_id UUID REFERENCES docgrid.workspace_projects(id),title TEXT,path TEXT,content TEXT,version INT DEFAULT 1,updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE docgrid.workspace_document_versions(document_id UUID REFERENCES docgrid.workspace_documents(id),version INT,content TEXT,author_id TEXT,message TEXT,created_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(document_id,version));
      INSERT INTO docgrid."User" VALUES('owner','owner@example.test'),('stranger','stranger@example.test');`);
    for(const migration of ['20260918213000_add_docgrid_gitlaw','20260921170000_docgrid_core','20260924220000_docgrid_material_storage','20260921100000_add_document_workflow','20260925121500_docgrid_agent_oauth',...fs.readdirSync('prisma/migrations').filter(p=>/astra_/.test(p)).sort(),'20260929100000_docgrid_builtin_and_extraction'])await exec(fs.readFileSync(`prisma/migrations/${migration}/migration.sql`,'utf8'));
    const projectId=randomUUID(), otherProject=randomUUID(), sourceId=randomUUID(), unreadId=randomUUID();
    await database.query('INSERT INTO docgrid.workspace_projects(id,owner_id,name) VALUES($1,\'owner\',\'Synthetic case\'),($2,\'stranger\',\'Other case\')',[projectId,otherProject]);
    const text='Источник. '.repeat(3000)+'100.10\n200.20'; const original=Buffer.from(text);
    for(const [id,bytes,extracted,status,title] of [[sourceId,original,text,'PARTIAL','Выписка.txt'],[unreadId,Buffer.from('%PDF-synthetic'),'','UNREAD','Скан.pdf']])await database.query('INSERT INTO docgrid.docgrid_materials(id,project_id,title,mime,bytes,sha256,extracted_text,extraction_status,created_by) VALUES($1,$2,$3,\'text/plain\',$4,$5,$6,$7,\'owner\')',[id,projectId,title,bytes,sha(bytes),extracted,status]);
    const storage=new Map();let failPdf=true,pdfAttempts=0;
    const files=new DocumentFileService({putObject:async(bytes,key)=>{storage.set(key,Buffer.from(bytes));},getObject:async key=>{if(!storage.has(key))throw new (require('@nestjs/common').InternalServerErrorException)('S3 download failed (404).');return storage.get(key);}});
    files.convertDocxToPdf=async()=>{pdfAttempts++;if(failPdf)throw Error('synthetic converter unavailable');return Buffer.from('%PDF-synthetic-proof');};
    const sources=new AstraSourcesService(),workflow=new AstraWorkflowService(files,sources),db=adapter(database,transact),service=new AstraService(db,sources,workflow,new AstraUploadService());
    const executeWorkflow=workflow.execute.bind(workflow);
    workflow.execute=async(...args)=>{try{return await executeWorkflow(...args);}catch(error){if(!error.getStatus)console.error('Synthetic workflow failure:',error);throw error;}};
    const actions=[...ASTRA_SOURCE_TOOLS,...ASTRA_WORKFLOW_TOOLS,...ASTRA_UPLOAD_TOOLS,'docgrid_get_capabilities','docgrid_get_operation','docgrid_cancel_operation'];
    const grantBody={requestKey:'grant-1',agentRef:'fixture-astra',actions,expiresAt:new Date(Date.now()+3600000).toISOString(),maxOperations:100};
    await assert.rejects(()=>service.createGrant('stranger',projectId,grantBody),e=>e.getStatus()===404);
    const issued=await service.createGrant('owner',projectId,grantBody),token=issued.token;
    assert.match(token,/^dga_[\w-]{43}$/);
    const beforeDiscovery=(await service.listGrants('owner',projectId)).grants[0].usedOperations;
    const discovery=await service.describeGrant(token,projectId);
    assert.equal(discovery.executionTrack,'DOCGRID_AGENT');
    assert.equal((await service.listGrants('owner',projectId)).grants[0].usedOperations,beforeDiscovery,'discovery consumes no operations');
    for (const agentRef of ['ChatGPT', 'Claude', 'Gemini', 'Local model']) {
      const ordinary=await service.createGrant('owner',projectId,{...grantBody,requestKey:'grant-'+agentRef,agentRef,actions:['docgrid_list_tree']});
      const catalog=await service.describeGrant(ordinary.token,projectId);
      assert.deepEqual(catalog.tools.map(t=>t.name).sort(),['docgrid_get_capabilities','docgrid_list_tree']);
      await assert.rejects(()=>service.describeGrant(ordinary.token,otherProject),e=>e.getStatus()===401);
    }
    const oauthStore=new AgentOAuthCodeStore(db), codeHash=sha('authorization-code'),bindingHash=sha('client-redirect-resource-pkce');
    await oauthStore.save({codeHash,bindingHash,sealedToken:'encrypted-only'});
    await assert.rejects(()=>oauthStore.consume({codeHash,bindingHash:sha('wrong-pkce')}),e=>e.getStatus()===401);
    const exchanges=await Promise.allSettled([oauthStore.consume({codeHash,bindingHash}),oauthStore.consume({codeHash,bindingHash})]);
    assert.equal(exchanges.filter(x=>x.status==='fulfilled').length,1,'authorization code consumes atomically once');
    await oauthStore.save({codeHash:sha('expired'),bindingHash,sealedToken:'encrypted-only'});
    await database.query('UPDATE docgrid.dg_agent_oauth_codes SET expires_at=now()-interval \'1 second\'');
    await assert.rejects(()=>oauthStore.consume({codeHash:sha('expired'),bindingHash}),e=>e.getStatus()===401);

    assert.equal((await service.createGrant('owner',projectId,grantBody)).token,null,'secret shown once');
    await assert.rejects(()=>service.createGrant('owner',projectId,{...grantBody,maxOperations:101}),e=>e.getStatus()===409);
    let seq=0;
    const call=(tool,input={},key='op-'+(++seq))=>service.execute(token,tool,{projectId,runId:'synthetic-run',traceId:'trace-'+seq,requestKey:key,input});
    const approve=op=>service.decideOperation('owner',projectId,op.id,'approve',{requestKey:'human-'+op.id,approvalDigest:op.approvalDigest,...(op.approval?.planRevision?{planRevision:op.approval.planRevision}:{})});
    const uploadInput={files:[{name:'Fixture.txt',path:'/Incoming/nested',mimeType:'text/plain',contentBase64:Buffer.from('fixture original').toString('base64')}]};
    const uploaded=await call('docgrid_upload_sources',uploadInput,'upload-once');
    assert.equal((await call('docgrid_upload_sources',uploadInput,'upload-once')).id,uploaded.id);
    const uploadAudit=(await database.query('SELECT input FROM docgrid.dg_astra_operations WHERE id=$1',[uploaded.id])).rows[0].input;
    assert.equal(JSON.stringify(uploadAudit).includes(uploadInput.files[0].contentBase64),false,'operation audit must not duplicate original bytes');
    const snap=await call('docgrid_get_snapshot',{capture:true},'capture');
    assert.equal((await call('docgrid_get_snapshot',{capture:true},'capture')).id,snap.id);
    assert.equal((await database.query('SELECT count(*)::int AS n FROM docgrid.dg_astra_snapshots')).rows[0].n,1);
    const ref=snap.output.manifest.find(s=>s.sourceId===sourceId).sourceRef;
    const unread=snap.output.manifest.find(s=>s.sourceId===unreadId).sourceRef;
    const read=await call('docgrid_read_source',{sourceRef:ref,maxChars:100});
    assert.equal(read.output.status,'PARTIAL');assert.equal(read.output.truncated,true);assert.equal(read.output.text.length,100);
    const next=await call('docgrid_read_source',{sourceRef:ref,maxChars:100,cursor:read.output.continuation});assert.equal(next.output.locator.start,100);
    await assert.rejects(()=>call('docgrid_read_source',{sourceRef:ref,maxChars:101,cursor:read.output.continuation}),e=>e.getStatus()===400);
    assert.equal((await call('docgrid_read_source',{sourceRef:unread})).output.status,'UNREAD');
    const search=await call('docgrid_search',{snapshotId:snap.output.snapshotId,query:'Источник',mode:'fulltext'});assert.equal(search.output.index.complete,false);
    await assert.rejects(()=>service.execute(token,'docgrid_get_project',{projectId:otherProject,runId:'run',traceId:'t',input:{}}),e=>[401,403,404].includes(e.getStatus()));
    const planInput={purpose:'Составить синтетическую справку',requestedResult:'DOCX/PDF',sourceSnapshotId:snap.output.snapshotId,sourceRefs:[ref],plan:{title:'Справка',documentType:'memo',goal:'Проверить данные',sections:['Данные'],warnings:['Частичное извлечение']}};
    let plan=await call('docgrid_plan_document',planInput);
    const content={title:'Справка',sections:[{id:'section1',heading:'Данные',paragraphIds:['p1'],paragraphs:['Сумма по исходным сведениям.'],tables:[{id:'table1',headers:['Основание','Сумма'],rows:[['Первый платеж','100,10'],['Второй платеж','200,20']]}]}]};
    const submitInput=()=>({taskId:plan.output.taskId,planRevision:plan.output.planRevision,planDigest:plan.output.planDigest,content});
    await assert.rejects(()=>call('docgrid_submit_document',submitInput()),e=>e.getStatus()===409);
    assert.equal((await database.query('SELECT count(*)::int AS n FROM docgrid.prepared_legal_documents')).rows[0].n,0);
    assert.equal(storage.size,0);
    const oldPlan=plan;plan=await call('docgrid_plan_document',{...planInput,taskId:oldPlan.output.taskId,basePlanRevision:1,purpose:'Уточнить синтетическую справку'});
    await assert.rejects(()=>approve(oldPlan),e=>e.getStatus()===409);
    await assert.rejects(()=>service.decideOperation('stranger',projectId,plan.id,'approve',{requestKey:'forged',approvalDigest:plan.approvalDigest,planRevision:2}),e=>e.getStatus()===404);
    await approve(plan);
    const [result,replay]=await Promise.all([call('docgrid_submit_document',submitInput(),'submit-once'),call('docgrid_submit_document',submitInput(),'submit-once')]);
    assert.equal(result.id,replay.id);assert.equal(result.output.version,1);
    const artifactId=result.output.artifactId;
    assert.equal((await service.listArtifacts('owner',projectId)).artifacts[0].artifactId,artifactId);
    await assert.rejects(()=>service.listArtifacts('stranger',projectId),e=>e.getStatus()===404);
    assert.equal(result.output.stableUrl,`/projects/${projectId}?section=files&artifactId=${artifactId}&version=1`);

    assert.equal((await database.query('SELECT count(*)::int AS n FROM docgrid.document_versions')).rows[0].n,1);
    const human=await service.humanArtifact('owner',projectId,artifactId,1);assert.equal(human.title,'Справка');
    const patch1=await call('docgrid_propose_patch',{artifactId,baseVersion:1,changes:[{blockId:'p1',type:'replace_paragraph',text:'Первая правка.'}]});
    const patch2=await call('docgrid_propose_patch',{artifactId,baseVersion:1,changes:[{blockId:'p1',type:'replace_paragraph',text:'Параллельная правка.'}]});
    const patchDecisions=await Promise.allSettled([approve(patch1),approve(patch2)]);
    assert.equal(patchDecisions.filter(p=>p.status==='fulfilled').length,1);
    assert.equal(patchDecisions.find(p=>p.status==='rejected').reason.getStatus(),409);
    const exported=await call('docgrid_export_version',{artifactId,version:2,format:'both'});assert.equal(exported.output.exportStatus,'PREVIEW_FAILED');assert.ok(exported.output.docxUrl);assert.equal(exported.output.pdfUrl,null);
    const docxKey=(await database.query('SELECT docx_object_key FROM docgrid.document_versions WHERE document_id=$1 AND version=2',[artifactId])).rows[0].docx_object_key;
    const docxHash=sha(storage.get(docxKey));failPdf=false;
    const retried=await call('docgrid_export_version',{artifactId,version:2,format:'both'});assert.equal(retried.output.exportStatus,'READY');assert.equal(sha(storage.get(docxKey)),docxHash);assert.equal(pdfAttempts,2);
    const download=await service.artifactFile('owner',false,projectId,artifactId,2,'docx');assert.equal(sha(download.bytes),docxHash);
    const limited=await service.createGrant('owner',projectId,{...grantBody,requestKey:'limited',allowedSourceIds:[unreadId]});
    await assert.rejects(()=>service.execute(limited.token,'docgrid_get_history',{projectId,runId:'limited',traceId:'limited',input:{artifactId}}),e=>[403,404].includes(e.getStatus()));
    await service.revokeGrant('owner',projectId,issued.grant.id,{requestKey:'revoke'});
    await assert.rejects(()=>service.describeGrant(token,projectId),e=>e.getStatus()===403);
    await assert.rejects(()=>call('docgrid_get_snapshot',{capture:true},'capture'),e=>e.getStatus()===403);
    await assert.rejects(()=>service.artifactFile(token,true,projectId,artifactId,2,'docx'),e=>e.getStatus()===403);
    assert.equal(sha((await service.artifactFile('owner',false,projectId,artifactId,2,'docx')).bytes),docxHash,'human retains own artifacts after revocation');
    assert.equal((await database.query('SELECT sha256 FROM docgrid.docgrid_materials WHERE id=$1',[sourceId])).rows[0].sha256,sha(original));
    const capped=await service.createGrant('owner',projectId,{...grantBody,requestKey:'cap',maxOperations:1});
    const capResults=await Promise.allSettled([1,2].map(i=>service.execute(capped.token,'docgrid_get_project',{projectId,runId:'cap',traceId:'cap-'+i,input:{}})));
    assert.equal(capResults.filter(p=>p.status==='fulfilled').length,1);
    assert.equal(capResults.find(p=>p.status==='rejected').reason.getStatus(),403);
    console.log(`PASS ASTRA synthetic acceptance — ${mode}: scoped grants, snapshot integrity, partial continuation, stale approval, one version on duplicate submit, concurrent CAS conflict, PDF failure/retry, protected downloads, revoke and budget cap.`);
  } finally { await close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});


