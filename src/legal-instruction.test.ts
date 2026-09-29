import test from 'node:test';
import { strict as assert } from 'node:assert';
import { validateLegalInstructionResponse,instructionDocument,resolveDiscussionTask } from './modules/docgrid/legal-instruction.protocol';
const sources=[{id:'s1',title:'Договор',path:'/',text:'Оплата в течение 10 дней. Сумма 100 рублей.',status:'READY'}];
const fixture=()=>({answer:'Инструкция подготовлена',warnings:[],legalInstruction:{title:'Порядок взыскания задолженности',goal:'Подготовить доказательства требования',facts:[{text:'Срок оплаты указан в договоре',evidence:[{sourceId:'s1',quote:'Оплата в течение 10 дней.'}]}],steps:[{action:'Сопоставить договор и оплату',purpose:'Установить исполнение обязательства',documents:['Договор','Выписка'],deadline:'10 дней',evidence:[{sourceId:'s1',quote:'Оплата в течение 10 дней.'}]}],legalBasis:[],missingData:['Дата начала срока'],risks:['Проверить расчёт срока'],checklist:['Сумма подтверждена первичными документами']}});
test('legal instructions use a fixed folder without moving evidence and render seven sections',()=>{
 const result=validateLegalInstructionResponse({...fixture(),package:{folder:'/foreign',sourceIds:['s1']}},sources,'helper');
 assert.equal(result.package?.folder,'/Юридические инструкции');assert.deepEqual(result.package?.sourceIds,[]);assert.equal(result.package?.payment,null);
 assert.equal(instructionDocument(result.legalInstruction!).sections.length,7);assert.match(result.package!.documents[0].text,/## Порядок действий/);
 assert.throws(()=>validateLegalInstructionResponse(fixture(),sources,'advisor'));
});
test('instruction evidence rejects invented quotes, foreign IDs and unsupported deadlines',()=>{
 for(const change of [(v:any)=>v.facts[0].evidence[0].quote='Выдумка',(v:any)=>v.facts[0].evidence[0].sourceId='outside',(v:any)=>v.facts[0].evidence=[],(v:any)=>v.steps[0].deadline='30 дней']){
  const x=fixture();change(x.legalInstruction);assert.throws(()=>validateLegalInstructionResponse(x,sources,'helper'));
 }
 const refused=validateLegalInstructionResponse({answer:'Это техническая задача',warnings:[],legalInstruction:null},sources,'helper');assert.equal(refused.package,null);
});
test('explicit natural language request resolves to instruction; advisor and ordinary chat remain unchanged',()=>{
 assert.equal(resolveDiscussionTask('chat','Подготовь юридическую инструкцию по взысканию','helper'),'instruction');
 assert.equal(resolveDiscussionTask('chat','Подготовь инструкцию','advisor'),'chat');assert.equal(resolveDiscussionTask('chat','Как взыскать долг?','helper'),'chat');
});
