import 'reflect-metadata';
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {DiscussionService} from './modules/docgrid/discussion.service';
test('LLM configuration distinguishes missing setup, authentication, disabled provider and no models without leaking secrets',async()=>{
 const env={url:process.env.DOCGRID_ORCHESTRA_URL,token:process.env.DOCGRID_SERVICE_TOKEN},original=global.fetch;
 const service=new DiscussionService({} as any,{} as any) as any;
 try{
  delete process.env.DOCGRID_ORCHESTRA_URL;assert.equal((await service.providerConfig()).connectionStatus,'backend_not_configured');
  process.env.DOCGRID_ORCHESTRA_URL='https://fixture.invalid';process.env.DOCGRID_SERVICE_TOKEN='s'.repeat(40);
  global.fetch=async()=>new Response('',{status:401});assert.equal((await service.providerConfig()).connectionStatus,'service_auth_failed');
  global.fetch=async()=>Response.json({enabled:false,discussionModels:[]});assert.equal((await service.providerConfig()).connectionStatus,'orchestra_disabled');
  global.fetch=async()=>Response.json({enabled:true,discussionModels:[]});assert.equal((await service.providerConfig()).connectionStatus,'no_models');
  global.fetch=async()=>Response.json({enabled:true,discussionModels:[{id:'default',label:'Fixture'}]});assert.equal((await service.providerConfig()).available,true);
  global.fetch=async()=>{throw Error(process.env.DOCGRID_SERVICE_TOKEN)};const down=await service.providerConfig();assert.equal(down.connectionStatus,'unreachable');assert.ok(!JSON.stringify(down).includes('s'.repeat(40)));
 }finally{global.fetch=original;if(env.url===undefined)delete process.env.DOCGRID_ORCHESTRA_URL;else process.env.DOCGRID_ORCHESTRA_URL=env.url;if(env.token===undefined)delete process.env.DOCGRID_SERVICE_TOKEN;else process.env.DOCGRID_SERVICE_TOKEN=env.token;}
});
