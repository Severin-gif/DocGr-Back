import {test} from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {RICH_PREFIX,normalizeDocumentContent,checkDocument,contentHash} from './modules/docgrid/document-quality';
import {renderWorkspaceDocx} from './modules/docgrid/workspace-document-export';
const rich=(s:string)=>normalizeDocumentContent(RICH_PREFIX+s);
const table=(total:string,extra='')=>rich('<table><tr><th>Платёж</th><th>Сумма, ₽</th></tr><tr><td>Первый</td><td>30 000,10</td></tr><tr><td>Второй</td><td>50 000,20</td></tr>'+extra+'<tr><td>Итого</td><td>'+total+'</td></tr></table>');
test('canonical blocks retain identity and text, are idempotent, remove unsafe decoration',()=>{
 const source=RICH_PREFIX+'<p data-check-level="error" onclick="bad()">Сумма <b>100 ₽</b></p><script>bad()</script><p data-dg-block="b-8">Срок</p>';
 const normalized=normalizeDocumentContent(source);
 assert.equal(normalizeDocumentContent(normalized),normalized);assert.match(normalized,/data-dg-block="b-9"/);assert.match(normalized,/data-dg-block="b-8"/);assert.doesNotMatch(normalized,/script|onclick|data-check-level/);assert.match(normalized,/Сумма <b>100 ₽<\/b>/);
 const inserted=normalizeDocumentContent(normalized.replace('<p data-dg-block="b-8">','<p>Новый</p><p data-dg-block="b-8">'));
 assert.match(inserted,/data-dg-block="b-8">Срок/);assert.match(inserted,/data-dg-block="b-9">Сумма/);
 assert.equal(checkDocument(rich('10 + <b>20</b> = 40'),1).errors,1);
 assert.equal(normalizeDocumentContent('# Legacy\nText'),'# Legacy\nText');
});
test('exact cents table check, anchored total and contributing cells',()=>{
 const source=table('80 000,31'),result=checkDocument(source,4);assert.equal(result.errors,1);assert.equal(result.revision,4);assert.equal(result.contentHash,contentHash(source));
 const issue=result.issues[0];assert.equal(issue.rule,'table_total');assert.equal(issue.anchor.quote,'80 000,31');assert.equal(issue.related.length,2);assert.match(issue.explanation,/80 000,30/);
 assert.equal(checkDocument(table('80 000,30'),5).errors,0);
});
test('adjustments, mixed currencies and unrelated prose are not falsely marked red',()=>{
 assert.equal(checkDocument(table('90 000,30','<tr><td>НДС</td><td>10 000</td></tr>'),1).errors,0);
 assert.equal(checkDocument(table('90 000,30','<tr><td>НДС</td><td>10 000</td></tr>'),1).warnings,1);
 const mixed=checkDocument(rich('<p>10 USD + 20 EUR = 30 USD</p>'),1);assert.equal(mixed.errors,0);assert.equal(mixed.warnings,1);
 assert.equal(checkDocument(table('90 000,30','<tr><td>Раздельные значения</td><td><p>30</p><p>20</p></td></tr>'),1).errors,0);
 assert.equal(checkDocument(rich('<p>Цена 100 рублей. Аванс 40 рублей. Штраф 50 рублей.</p>'),1).errors,0);
});
test('explicit equations support cents, negative values and large exact integers',()=>{
 assert.equal(checkDocument(rich('<p>0,10 + 0,20 = 0,30</p>'),1).errors,0);
 assert.equal(checkDocument(rich('<p>-0,10 + 0,20 = 0,10</p>'),1).errors,0);
 assert.equal(checkDocument(rich('<p>9007199254740991 + 1 = 9007199254740993</p>'),1).errors,1);
});
test('money equations share full currency spellings and preserve exact error anchors',()=>{
 for(const [expression,total,expected] of [
  ['10 рублей + 20 рублей = 40 рублей','40 рублей','30,00'],
  ['Расчёт: 10 рублей + 20 рублей = 40 рублей.','40 рублей','30,00'],
  ['1 рубль + 2 рубля = 4 рубля','4 рубля','3,00'],
  ['10 РУБЛЕЙ + 20 РУБЛЕЙ = 40 РУБЛЕЙ','40 РУБЛЕЙ','30,00'],
  ['1\u00a0000,10 рублей + 2\u202f000,20 рублей = 3 000,31 рублей','3 000,31 рублей','3 000,30'],
  ['-0,10 рубля + 0,20 рубля = 0,11 рубля','0,11 рубля','0,10'],
  ['10 долларов + 20 долларов = 40 долларов','40 долларов','30,00'],
  ['10 евро + 20 евро = 40 евро','40 евро','30,00'],
 ]){
  for(const source of [expression,rich('<p>'+expression+'</p>')]){
   const result=checkDocument(source,8);
   assert.equal(result.errors,1,expression);assert.equal(result.warnings,0,expression);
   const issue=result.issues[0];assert.equal(issue.rule,'equation_total');assert.equal(issue.anchor.quote,total);
   assert.equal(issue.anchor.start,expression.indexOf(total));assert.equal(issue.anchor.end,expression.indexOf(total)+total.length);
   assert.ok(issue.explanation.includes('Сумма слева: '+expected));
   assert.equal(result.contentHash,contentHash(source));assert.equal(result.revision,8);
  }
 }
 for(const expression of ['10 рублей + 20 рублей = 30 рублей','1 рубль + 2 рубля = 3 рубля','10 руб. + 20 ₽ = 30 рублей','0,10 рублей + 0,20 рублей = 0,30 рублей']){
  assert.equal(checkDocument(expression,1).issues.length,0,expression);
 }
 const mixed=checkDocument('10 рублей + 20 USD = 30 рублей',1);
 assert.equal(mixed.errors,0);assert.equal(mixed.warnings,1);assert.equal(mixed.issues[0].rule,'mixed_units');
 const multiple=checkDocument(rich('<p>10 рублей + 20 рублей = 40 рублей</p><p>1 рубль + 2 рубля = 4 рубля</p>'),1);
 assert.equal(multiple.errors,2);
});
test('negative durations cover grammatical day forms in plain and rich documents',()=>{
 for(const expression of ['срок: -1 день','в течение -2 дня','в течение -5 дней','срок оплаты — -21 календарных день','в течение -2 рабочих дня']){
  for(const source of [expression,rich('<p>'+expression+'</p>')]){
   const result=checkDocument(source,1);assert.equal(result.errors,1,expression);assert.equal(result.warnings,0);
   assert.equal(result.issues[0].rule,'negative_duration');assert.equal(result.issues[0].anchor.quote,expression);
   assert.equal(result.issues[0].anchor.start,0);assert.equal(result.issues[0].anchor.end,expression.length);
  }
 }
 for(const expression of ['срок: 1 день','в течение 2 дня после подписания','в течение 5 дней после подписания','срок: -1 деньгами']){
  assert.equal(checkDocument(expression,1).errors,0,expression);
 }
});
test('calendar validity, explicit ranges and ambiguous legal triggers',()=>{
 const result=checkDocument(rich('<p>Дата 31.02.2026</p><p>с 10.05.2026 по 01.05.2026</p><p>в течение 5 дней</p><p>в течение 5 дней после подписания</p><p>в течение -3 дней</p>'),1);
 assert.equal(result.errors,3);assert.equal(result.warnings,1);assert.ok(result.issues.every(i=>i.anchor.blockId.startsWith('b-')));
 assert.equal(checkDocument(rich('<p>29.02.2024; с 01.05.2026 по 10.05.2026</p>'),1).errors,0);
});
test('report cap cannot conceal later errors from merge enforcement',()=>{
 const result=checkDocument(rich('<p>в течение 5 дней</p>'.repeat(210)+'<p>31.02.2026</p>'),1);
 assert.equal(result.issues.length,200);assert.equal(result.errors,1);assert.equal(result.warnings,210);assert.match(result.limitations[0],/200/);
});
test('DOCX uses canonical paragraphs, headings and lists without check decorations',async()=>{
 const bytes=await renderWorkspaceDocx(rich('<h1>Договор</h1><p>Текст</p><ol><li><p>Первый</p><p>Продолжение пункта</p></li><li>Второй</li></ol><ul><li>Пункт</li></ul>'));
 const zip=await JSZip.loadAsync(bytes),xml=await zip.file('word/document.xml')!.async('string'),styles=await zip.file('word/styles.xml')!.async('string'),numbering=await zip.file('word/numbering.xml')!.async('string');
 assert.equal((xml.match(/<w:numPr>/g)||[]).length,3);
 assert.match(xml,/w:pStyle w:val="Heading1"/);assert.match(xml,/w:firstLine="709"/);assert.match(xml,/w:numPr/);assert.match(numbering,/w:numFmt w:val="decimal"/);assert.match(numbering,/w:numFmt w:val="bullet"/);assert.match(styles,/Times New Roman/);assert.doesNotMatch(xml,/data-dg-block|data-check|docgrid/);
});

test('canonical sanitation retains bounded Word layout but removes hostile style rules',()=>{
 const result=rich('<p style="font-family:Times New Roman;font-size:14pt;margin-left:144pt;text-indent:0pt;line-height:1.5;text-align:right;position:fixed;background-image:url(https://example.test)">Шапка 100 ₽</p>');
 assert.match(result,/font-family:&quot;Times New Roman&quot;/);assert.match(result,/font-size:14pt/);assert.match(result,/margin-left:144pt/);assert.match(result,/text-align:right/);assert.doesNotMatch(result,/position|background-image|url\(/);assert.match(result,/Шапка 100 ₽/);
 assert.doesNotMatch(rich('<p style="font-size:999pt;margin-left:-300pt">Текст</p>'),/font-size|margin-left/);
});
