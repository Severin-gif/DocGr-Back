import { safeDocumentStyle } from './document-format';
import { createHash } from 'node:crypto';
import { parseFragment, serialize, DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
export const RICH_PREFIX = '<!-- docgrid-richtext-v1 -->';
export const CHECK_ENGINE_VERSION = 'document-quality-v1';
const blockTags = new Set(['p','div','h1','h2','h3','h4','h5','h6','li','td','th']);
const allowedTags = new Set([...blockTags,'br','b','strong','i','em','u','span','table','thead','tbody','tfoot','tr','ul','ol']);
const forbidden = new Set(['script','style','iframe','object','svg','math','template','img','link']);
const element = (n:Node):n is Element => 'tagName' in n;
export function textOf(n:Node):string {
  if(n.nodeName==='#text')return (n as DefaultTreeAdapterMap['textNode']).value;
  if(element(n)&&forbidden.has(n.tagName))return '';
  if(element(n)&&n.tagName==='br')return '\n';
  return 'childNodes' in n?n.childNodes.map(textOf).join(''):'';
}
function safeCss(css:string) {
  return css.split(';').flatMap(rule=>{
    const [key,...parts]=rule.split(':'),value=parts.join(':').trim(),property=key.trim();
    const safe=safeDocumentStyle(property,value);
    return safe!==null?[property+':'+safe]:[];
  }).join(';');
}
/** Canonical serialization: stable block IDs and one top-level block per line.
 * Only formatting metadata changes; document text, figures and dates are not corrected. */
export function normalizeDocumentContent(content:string):string {
  if(!content.startsWith(RICH_PREFIX))return content;
  const root=parseFragment(content.slice(RICH_PREFIX.length));
  const used=new Set<string>();let counter=0;
  const clean=(nodes:Node[],depth=0):Node[]=>{
    if(depth>100)throw new Error('Слишком сложное оформление документа');
    return nodes.flatMap(n=>{
      if(!element(n))return n.nodeName==='#text'?[n]:[];
      if(forbidden.has(n.tagName))return [];
      n.childNodes=clean(n.childNodes,depth+1);
      if(!allowedTags.has(n.tagName))return n.childNodes;
      const attrs=n.attrs.flatMap(a=>{
        if(a.name==='style'){const css=safeCss(a.value);return css?[{name:'style',value:css}]:[];}
        if(['colspan','rowspan'].includes(a.name)&&['td','th'].includes(n.tagName)&&/^\d{1,3}$/.test(a.value)&&Number(a.value)>0&&Number(a.value)<=100)return [a];
        if(a.name==='data-dg-block'&&blockTags.has(n.tagName)&&/^b-[a-zA-Z0-9_-]{1,64}$/.test(a.value))return [a];
        return [];
      });
      n.attrs=attrs.sort((a,b)=>a.name.localeCompare(b.name));
      return [n];
    });
  };
  root.childNodes=clean(root.childNodes);
  // contenteditable may emit bare text or inline runs after replacing all text.
  // Group these runs into paragraphs rather than letting them escape block checks.
  const topBlocks=new Set(['p','div','h1','h2','h3','h4','h5','h6','table','ul','ol']);
  const grouped:Node[]=[];let inline:Node[]=[];
  const flushInline=()=>{if(!inline.length)return;if(inline.some(n=>element(n)||textOf(n).trim())){const p=parseFragment('<p></p>').childNodes[0] as Element;p.childNodes=inline;p.parentNode=root;inline.forEach(n=>{n.parentNode=p;});grouped.push(p);}inline=[];};
  for(const n of root.childNodes){if(element(n)&&topBlocks.has(n.tagName)){flushInline();grouped.push(n);}else inline.push(n);}flushInline();root.childNodes=grouped;
  // Allocate IDs after sanitation in DOM order (same order used by the browser).
  const assign=(n:Node)=>{
    if(!element(n))return;
    if(blockTags.has(n.tagName)){
      let id=n.attrs.find(a=>a.name==='data-dg-block')?.value;
      if(!id||used.has(id)){do{id='b-'+(++counter);}while(used.has(id));}
      used.add(id);n.attrs=n.attrs.filter(a=>a.name!=='data-dg-block');n.attrs.push({name:'data-dg-block',value:id});
    }
    n.childNodes.forEach(assign);
  };
  // Reserve original IDs to prevent a newly inserted block from stealing one.
  const reserved=(n:Node)=>{if(element(n)){const id=n.attrs.find(a=>a.name==='data-dg-block')?.value;if(id&&/^b-\d{1,9}$/.test(id))counter=Math.max(counter,Number(id.slice(2)));n.childNodes.forEach(reserved);}};
  root.childNodes.forEach(reserved);root.childNodes.forEach(assign);
  const pieces:string[]=[];
  for(const node of root.childNodes){
    if(node.nodeName==='#text'&&!textOf(node).trim())continue;
    pieces.push(serialize({...root,childNodes:[node]}));
  }
  return RICH_PREFIX+'\n'+pieces.join('\n');
}

export type CheckAnchor = {blockId:string;blockIndex:number;quote:string;start:number;end:number};
export type DocumentIssue = {id:string;severity:'error'|'warning';rule:string;message:string;explanation:string;anchor:CheckAnchor;related:CheckAnchor[]};
export type DocumentCheck = {engineVersion:string;revision:number;contentHash:string;issues:DocumentIssue[];checkedBlocks:number;errors:number;warnings:number;limitations:string[]};
export function contentHash(content:string){return createHash('sha256').update(content).digest('hex');}
const currency=(s:string):string|undefined => /₽|руб(?:\.|лей|ля|ль)?/i.test(s)?'RUB':/\$|USD|доллар/i.test(s)?'USD':/€|EUR|евро/i.test(s)?'EUR':undefined;
function money(s:string):{value:bigint;unit?:string}|null {
  const m=/^\s*(-?\d+(?:[ \u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?)\s*(₽|руб(?:\.|лей|ля|ль)?|\$|USD|доллар(?:ов|а)?|€|EUR|евро)?\s*$/i.exec(s);
  if(!m)return null;
  const value=m[1].replace(/[ \u00a0\u202f]/g,'').replace(',','.');
  const [integer,decimal='']=value.split('.');
  try{return {value:BigInt(integer)*100n+BigInt(decimal.padEnd(2,'0'))*(value.startsWith('-')?-1n:1n),unit:m[2]?currency(m[2]):undefined};}catch{return null;}
}
function amount(v:bigint){const sign=v<0n?'-':'';v=v<0n?-v:v;return sign+(v/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,' ')+','+(v%100n).toString().padStart(2,'0');}
function date(s:string):number|null {
  const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);if(!m)return null;
  const [day,month,year]=m.slice(1).map(Number);
  if(year<1000||year>9999)return null;
  const d=new Date(Date.UTC(year,month-1,day));
  return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?d.getTime():null;
}
export function checkDocument(content:string,revision:number):DocumentCheck {
  const root=content.startsWith(RICH_PREFIX)?parseFragment(content.slice(RICH_PREFIX.length)):null;
  const blocks:Array<{node?:Element;text:string;id:string;index:number}>=[];
  const tables:Element[]=[];const byNode=new Map<Element,typeof blocks[number]>();
  const visit=(n:Node)=>{if(!element(n))return;if(forbidden.has(n.tagName))return;if(blockTags.has(n.tagName)){const index=blocks.length;blocks.push({node:n,text:textOf(n),id:n.attrs.find(a=>a.name==='data-dg-block')?.value||'block-'+index,index});byNode.set(n,blocks[blocks.length-1]);}if(n.tagName==='table')tables.push(n);n.childNodes.forEach(visit);};
  if(root)root.childNodes.forEach(visit);else content.split('\n').forEach((text,index)=>blocks.push({text,id:'plain-'+index,index}));
  const issues:DocumentIssue[]=[],seen=new Set<string>();let errors=0,warnings=0;
  const anchor=(b:typeof blocks[number],quote:string,start=b.text.indexOf(quote)):CheckAnchor=>({blockId:b.id,blockIndex:b.index,quote,start:Math.max(0,start),end:Math.max(0,start)+quote.length});
  const issue=(severity:DocumentIssue['severity'],rule:string,message:string,explanation:string,a:CheckAnchor,related:CheckAnchor[]=[])=>{
    const key=[rule,a.blockId,a.start,message].join('|');if(seen.has(key))return;seen.add(key);
    if(severity==='error')errors++;else warnings++;
    if(issues.length>=200)return;
    issues.push({id:key,severity,rule,message,explanation,anchor:a,related});
  };
  // Leaf textual blocks avoid reporting the same date twice through table/div ancestors.
  const leaf=blocks.filter(b=>!b.node||!b.node.childNodes.some(function contains(n:Node):boolean{return element(n)&&(blockTags.has(n.tagName)||n.childNodes.some(contains));}));
  for(const b of leaf){
    for(const m of b.text.matchAll(/(?<!\d)\d{2}\.\d{2}\.\d{4}(?!\d)/g))if(date(m[0])===null)issue('error','invalid_date','Несуществующая дата',`Дата ${m[0]} отсутствует в календаре. Проверьте исходный документ.`,anchor(b,m[0],m.index));
    for(const m of b.text.matchAll(/(?:период\s+)?с\s+(\d{2}\.\d{2}\.\d{4})\s+(?:по|до)\s+(\d{2}\.\d{2}\.\d{4})/gi)){
      const from=date(m[1]),to=date(m[2]);if(from!==null&&to!==null&&from>to)issue('error','reversed_date_range','Конец периода раньше начала',`${m[1]} позднее ${m[2]}. Проверяется только явно записанный диапазон, без расчёта юридического срока.`,anchor(b,m[0],m.index));
    }
    for(const m of b.text.matchAll(/(?:в течение|срок(?:\s+\S+){0,2}\s*[:—-])\s*(-\d+)\s+(?:(?:календарных|рабочих)\s+)?дней/gi))issue('error','negative_duration','Отрицательная продолжительность',`В выражении «${m[0]}» указано отрицательное число дней.`,anchor(b,m[0],m.index));
    // Explicit equations only. Never add unrelated amounts mentioned in prose.
    for(const m of b.text.matchAll(/(?<![\d.,])((?:-?\d+(?:[ \u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?\s*(?:₽|руб\.?|USD|EUR|\$|€)?\s*\+\s*)+-?\d+(?:[ \u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?\s*(?:₽|руб\.?|USD|EUR|\$|€)?)\s*=\s*(-?\d+(?:[ \u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?\s*(?:₽|руб\.?|USD|EUR|\$|€)?)(?![\d.,])/g)){
      const terms=m[1].split('+').map(money),total=money(m[2]);if(!total||terms.some(t=>!t))continue;
      const units=new Set([...terms.map(t=>t?.unit),total.unit].filter(Boolean));if(units.size>1){issue('warning','mixed_units','В равенстве разные валюты','Без курса и даты пересчёта эти суммы нельзя складывать.',anchor(b,m[0],m.index));continue;}
      const sum=terms.reduce((v,t)=>v+t!.value,0n);
      if(sum!==total.value)issue('error','equation_total','Равенство не сходится',`Сумма слева: ${amount(sum)}; справа: ${amount(total.value)}. Разница: ${amount(total.value-sum)}. Значения не исправлены.`,anchor(b,m[2].trim(),m.index!+m[0].lastIndexOf(m[2].trim())));
    }
    // Ambiguous legal deadlines are explicitly warnings, without guessing a trigger or calendar.
    for(const m of b.text.matchAll(/в течение\s+\d+\s+(?:(?:рабочих|календарных)\s+)?(?:дней|дня|день)/gi)){
      if(!/(?:со дня|с даты|после|с момента|получени|подписани|уведомлени)/i.test(b.text))issue('warning','deadline_trigger','Уточните начало срока','В этом абзаце не указано событие или дата начала отсчёта. Они могут быть определены в другом пункте; автоматическая ошибка не установлена.',anchor(b,m[0],m.index));
    }
  }
  for(const table of tables){
    const rows:Element[][]=[];
    const rowsOf=(n:Node)=>{if(!element(n))return;if(n!==table&&n.tagName==='table')return;if(n.tagName==='tr'){rows.push(n.childNodes.filter((c):c is Element=>element(c)&&['td','th'].includes(c.tagName)));return;}n.childNodes.forEach(rowsOf);};rowsOf(table);
    if(rows.length<3)continue;
    const headers=rows[0].map(textOf);
    const col=headers.findIndex(h=>/^(?:сумма|стоимость|сумма платежа|сумма оплаты)(?:\s|[,(:]|$)/i.test(h.trim()));if(col<0)continue;
    if(rows.some(row=>row.some(cell=>(Number(cell.attrs.find(a=>a.name==='colspan')?.value||1)>1||Number(cell.attrs.find(a=>a.name==='rowspan')?.value||1)>1))))continue;
    let parts:Array<{value:bigint;unit?:string;a:CheckAnchor}>=[],uncertain=false;
    for(const row of rows.slice(1)){
      const cell=row[col],label=row.filter((_,i)=>i!==col).map(textOf).join(' ').trim();if(!cell){uncertain=true;continue;}
      const text=textOf(cell).trim(),b=byNode.get(cell)!;
      const isTotal=/^(итого|всего|общая сумма)\s*[:—-]?$/i.test(label);
      // Multiple paragraphs in one cell are separate statements, not one number.
      let textBlocks=0;
      const countBlocks=(n:Node)=>{if(element(n)){if(blockTags.has(n.tagName))textBlocks++;n.childNodes.forEach(countBlocks);}};
      cell.childNodes.forEach(countBlocks);
      const parsed=textBlocks>1?null:money(text);
      if(isTotal){
        if(parsed&&parts.length>=2){
          const units=new Set([...parts.map(p=>p.unit||currency(headers[col])),parsed.unit||currency(headers[col])].filter(Boolean));
          if(uncertain||units.size>1){issue('warning','table_total_uncertain','Итог требует уточнения','В расчёте есть пропуски, корректировки или разные валюты. Автоматическое сложение может быть неверным.',anchor(b,text),parts.map(p=>p.a));}
          else {const sum=parts.reduce((v,p)=>v+p.value,0n);if(sum!==parsed.value)issue('error','table_total','Итог таблицы не сходится',`Сумма ${parts.length} строк: ${amount(sum)}; указанный итог: ${amount(parsed.value)}. Разница: ${amount(parsed.value-sum)}.`,anchor(b,text),parts.map(p=>p.a));}
        }
        parts=[];uncertain=false;continue;
      }
      if(/ндс|скидк|корректировк|остаток|аванс|сальдо|промежуточн/i.test(label))uncertain=true;
      if(parsed)parts.push({...parsed,a:anchor(b,text)});else if(text||label)uncertain=true;
    }
  }
  return {engineVersion:CHECK_ENGINE_VERSION,revision,contentHash:contentHash(content),issues,checkedBlocks:leaf.length,errors,warnings,limitations:[...(seen.size>200?['Показаны первые 200 замечаний. Все найденные ошибки учитываются при слиянии.']:[]),'Проверены явные равенства, итоги простых таблиц, календарные даты и диапазоны.','Правовые сроки, правила отсчёта, суммы прописью и соответствие внешним источникам требуют отдельной проверки.']};
}
