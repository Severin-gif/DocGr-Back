import test from 'node:test';
import assert from 'node:assert/strict';
import { passages } from './modules/docgrid/docgrid-passages';
import { combinePages } from './modules/docgrid/docgrid-ocr';
test('page ranges survive empty pages, Cyrillic and UTF-16 passage boundaries',()=>{
  const combined=combinePages([{page:3,text:'Итог 125000',method:'ocr',status:'READY'},{page:1,text:'я😀'.repeat(1800),method:'native',status:'READY'},{page:2,text:'',method:'ocr',status:'UNREAD'}]);
  const parts=passages(combined.text,combined.ranges);
  assert.ok(parts.length>3);
  for(const part of parts){assert.equal(part.text,combined.text.slice(part.start,part.end));assert.ok(part.text.length<=2400);assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text));assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));}
  assert.equal(parts.at(-1)?.page,3);assert.equal(parts.at(-1)?.text,'Итог 125000');
  const first=parts.filter(p=>p.page===1);assert.equal(first[0]?.start,0);assert.equal(first.at(-1)?.end,5400);
  first.slice(1).forEach((p,i)=>assert.ok(p.start<first[i]!.end));
});
