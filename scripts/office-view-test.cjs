const assert=require('node:assert/strict');
const JSZip=require('jszip');
const {officeView}=require('../dist/modules/docgrid/office-view');
const {renderWorkspaceDocx}=require('../dist/modules/docgrid/workspace-document-export');
(async()=>{
 const zip=async entries=>{const z=new JSZip();for(const [name,value] of Object.entries(entries))z.file(name,value);return z.generateAsync({type:'nodebuffer'});};
 const sheet=await zip({
  'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Расчёт" r:id="r1"/><sheet name="Второй" r:id="r2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml':'<sst><si><t>&lt;script&gt;test&lt;/script&gt;</t></si></sst>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="C3" t="s"><v>0</v></c><c r="E3"><v>100</v><f>50*2</f></c><c r="F3"><f>1+1</f></c><c r="A2001"><v>999</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':'<worksheet><sheetData><row><c r="B1" t="inlineStr"><is><t>Второй лист</t></is></c></row></sheetData></worksheet>'
 });
 const view=await officeView('calc.xlsx',sheet);
 assert.equal(view.kind,'spreadsheet');assert.equal(view.sheets.length,2);assert.equal(view.sheets[0].rows[0].index,2);
 assert.equal(view.sheets[0].rows[0].cells[0].column,2);assert.equal(view.sheets[0].rows[0].cells[1].value,'100');assert.equal(view.sheets[0].rows[0].cells[1].formula,'50*2');assert.equal(view.sheets[0].partial,true);
 assert.match(view.sheets[0].rows[0].cells[2].value,/нет сохранённого/);assert.equal(view.sheets[1].rows[0].cells[0].value,'Второй лист');
 const generated=await renderWorkspaceDocx('<!-- docgrid-richtext-v1 --><p style="text-align:center"><strong>Договор</strong><em> поставки</em></p><table><tbody><tr><td colspan="2"><p><u>Сумма 100 рублей</u></p></td></tr><tr><td><p>А</p></td><td><p>Б</p></td></tr></tbody></table>');
 const imported=await officeView('contract.docx',generated);
 assert.equal(imported.kind,'docx');assert.match(imported.html,/<table>/);assert.match(imported.html,/colspan="2"/);assert.match(imported.html,/font-weight:bold/);assert.match(imported.html,/font-style:italic/);assert.match(imported.html,/text-decoration:underline/);assert.match(imported.html,/text-align:center/);assert.match(imported.html,/Сумма 100 рублей/);
 const exported=await renderWorkspaceDocx('<!-- docgrid-richtext-v1 -->'+imported.html.replace('100 рублей','200 рублей'));
 const checked=await officeView('edited.docx',exported);assert.match(checked.html,/200 рублей/);assert.match(checked.html,/<table>/);assert.match(checked.html,/font-weight:bold/);
 const styled=await zip({
  'word/styles.xml':'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="28"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="709"/><w:spacing w:after="160" w:line="360"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Address"><w:basedOn w:val="Base"/><w:pPr><w:jc w:val="right"/><w:ind w:left="2880" w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>',
  'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Address"/></w:pPr><w:r><w:t>В Министерство природных ресурсов</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Base"/></w:pPr><w:r><w:t>Основной текст запроса.</w:t></w:r></w:p></w:body></w:document>'
 });
 const typography=await officeView('styled.docx',styled);assert.match(typography.html,/font-family:&#x27;Times New Roman&#x27;/);assert.match(typography.html,/font-size:16pt/);assert.match(typography.html,/font-weight:bold/);assert.match(typography.html,/text-align:right/);assert.match(typography.html,/margin-left:144pt/);assert.match(typography.html,/text-align:justify/);assert.match(typography.html,/text-indent:35.45pt/);
 const typographyExport=await renderWorkspaceDocx('<!-- docgrid-richtext-v1 -->'+typography.html),ty=await JSZip.loadAsync(typographyExport),xml=await ty.file('word/document.xml').async('string');
 assert.match(xml,/w:left="2880"/);assert.match(xml,/w:firstLine="709"/);assert.match(xml,/w:sz w:val="32"/);assert.match(xml,/w:jc w:val="right"/);assert.match(xml,/w:jc w:val="both"/);assert.match(xml,/w:after="160"/);
 const dtd=await zip({'word/document.xml':'<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d>&x;</d>'});
 await assert.rejects(()=>officeView('evil.docx',dtd),/Не удалось/);
 await assert.rejects(()=>officeView('broken.xlsx',Buffer.from('invalid')),/Не удалось/);
 await assert.rejects(()=>officeView('large.xlsx',Buffer.alloc(33*1024*1024)),/32 МБ/);
 await assert.rejects(()=>officeView('wrong.txt',Buffer.from('text')),/Поддерживаются/);
 console.log('PASS XLSX sheets, sparse coordinates, cached formulas, bounds; DOCX import-edit-export formatting and tables; malformed and oversized input, DTD rejection');
})().catch(e=>{console.error(e);process.exitCode=1;});
