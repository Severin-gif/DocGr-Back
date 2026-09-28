import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateDiscussionInput,validateDiscussionResult } from './modules/docgrid/discussion.protocol';
const sources=[{id:'s1',title:'Договор',path:'/',text:'ИНН 1234567890. Сумма 100 рублей.',status:'READY'}];
const result=()=>({answer:'Объяснение',warnings:[],classifications:[{sourceId:'s1',category:'Договор',destination:'/Договоры',reason:'Содержит обязательство',confidence:'high',evidence:[{sourceId:'s1',quote:'Сумма 100 рублей.'}]}],package:null});
test('discussion classification requires exact source quotes and scoped IDs',()=>{
 assert.equal(validateDiscussionResult(result(),sources,'helper').classifications.length,1);
 const bad=result();bad.classifications[0].evidence[0].quote='Придуманная цитата';assert.throws(()=>validateDiscussionResult(bad,sources,'helper'));
 const outside=result();outside.classifications[0].sourceId='foreign';assert.throws(()=>validateDiscussionResult(outside,sources,'helper'));
 const unsupported=result();unsupported.classifications[0].evidence=[];assert.throws(()=>validateDiscussionResult(unsupported,sources,'helper'));
 const traversal=result();traversal.classifications[0].destination='/../secret';assert.throws(()=>validateDiscussionResult(traversal,sources,'helper'));
});
test('payment values must be present in cited text; missing fields stay empty; advisor cannot prepare package',()=>{
 const pack={...result(),package:{folder:'/Дебиторка',documents:[{title:'Иск',text:'Черновик'}],sourceIds:['s1'],missingData:['Суд'],payment:[{field:'ИНН плательщика',value:'1234567890',evidence:[{sourceId:'s1',quote:'ИНН 1234567890.'}]}]}};
 assert.ok(validateDiscussionResult(pack,sources,'helper').package);
 assert.throws(()=>validateDiscussionResult(pack,sources,'advisor'));
 pack.package.payment[0].value='9999999999';assert.throws(()=>validateDiscussionResult(pack,sources,'helper'));
});
test('bounded context with explicit modes',()=>{
 assert.equal(validateDiscussionInput({mode:'advisor',instruction:'Объясни',sources,history:[],task:'chat'}).sources.length,1);
 assert.throws(()=>validateDiscussionInput({mode:'root',instruction:'X',sources}));
 assert.throws(()=>validateDiscussionInput({mode:'helper',instruction:'X',sources:Array(21).fill(sources[0])}));
});
