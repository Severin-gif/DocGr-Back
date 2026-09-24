import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

test('real gateway forwards multipart bytes and streams >32 MiB downloads behind human authentication', { timeout: 20000 }, async () => {
  let uploaded = Buffer.alloc(0);
  const chunk = Buffer.alloc(64 * 1024, 11), count = 640;
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers['x-docgrid-subject'], 'synthetic-user');
    assert.equal(req.headers['x-docgrid-service-token'], 'b'.repeat(64));
    assert.equal(req.headers.authorization, undefined);
    if (req.method === 'POST') {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      uploaded = Buffer.concat(chunks);
      res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'saved'}));
    } else {
      res.setHeader('content-type','application/octet-stream');
      res.setHeader('content-length',chunk.length*count);
      Readable.from((function* () { for(let i=0;i<count;i++)yield chunk; })()).pipe(res);
    }
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const upstreamPort = (upstream.address() as {port:number}).port;
  const reservation = createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port = (reservation.address() as {port:number}).port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const child = spawn(process.execPath,['dist/server.js'],{env:{NODE_ENV:'test',PORT:String(port),LEGAL_CORE_URL:`http://127.0.0.1:${upstreamPort}`,
    DOCGRID_IDENTITY_JWT_SECRET:'a'.repeat(64),DOCGRID_SERVICE_TOKEN:'b'.repeat(64)},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('gateway startup timeout')),10000);
      child.stdout.on('data',data=>{if(String(data).includes('BFF listening')){clearTimeout(timer);resolve();}});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('gateway exited'));});
    });
    const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const body = Buffer.from(JSON.stringify({sub:'synthetic-user',email:'user@example.test',role:'USER',plan:'pro',typ:'docgrid_access',iss:'ai-orchestra',aud:'legal-core-docgrid',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
    const token = `${header}.${body}.${createHmac('sha256','a'.repeat(64)).update(`${header}.${body}`).digest('base64url')}`;
    const id='123e4567-e89b-42d3-a456-426614174000';
    const url=`http://127.0.0.1:${port}/api/docgrid/repositories/${id}/materials`;
    const multipart=Buffer.from('--fixture\r\nContent-Disposition: form-data; name="path"\r\n\r\n/Дело/Суд\r\n--fixture\r\nContent-Disposition: form-data; name="file"; filename="proof.txt"\r\nContent-Type: text/plain\r\n\r\nOriginal\r\n--fixture--\r\n');
    const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'multipart/form-data; boundary=fixture'},body:multipart});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:'saved'});assert.deepEqual(uploaded,multipart);
    const denied=await fetch(`${url}/${id}/download`);assert.equal(denied.status,401);await denied.body?.cancel();
    const download=await fetch(`${url}/${id}/download`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(download.status,200);
    const digest=createHash('sha256'), expected=createHash('sha256');let size=0;
    for await(const bytes of Readable.fromWeb(download.body as import('node:stream/web').ReadableStream)){size+=bytes.length;digest.update(bytes);}
    for(let i=0;i<count;i++)expected.update(chunk);
    assert.equal(size,40*1024*1024);assert.equal(digest.digest('hex'),expected.digest('hex'));
  } finally {
    child.kill('SIGKILL');await once(child,'exit');
    upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
  }
});
