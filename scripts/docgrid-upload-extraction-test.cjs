const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText, file);
const { extractMaterialText, runLimitedExtraction, PDF_EXTRACTION_MAX_BYTES } = require('../src/modules/docgrid/docgrid-material-extraction.ts');

function pdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (DocGrid original evidence) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

(async () => {
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('docgrid-extract-')).sort();
  const original = pdf(), hash = createHash('sha256').update(original).digest('hex');
  const result = await extractMaterialText('evidence.pdf', original);
  assert.equal(result.status, 'READY');
  assert.match(result.text, /DocGrid original evidence/);
  assert.equal(createHash('sha256').update(original).digest('hex'), hash);
  console.log('PASS real Poppler extraction and unchanged original');

  const broken = await extractMaterialText('broken.pdf', Buffer.from('%PDF-1.4\ninvalid'));
  assert.equal(broken.status, 'UNREAD'); assert.equal(broken.text, '');
  const large = Buffer.alloc(PDF_EXTRACTION_MAX_BYTES + 1); large.write('%PDF-');
  assert.equal((await extractMaterialText('large.pdf', large)).reason, 'pdf_size_limit');
  const first = extractMaterialText('one.pdf', original);
  assert.equal((await extractMaterialText('two.pdf', original)).reason, 'pdf_busy');
  assert.equal((await first).status, 'READY');
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('docgrid-extract-')).sort(), before);
  console.log('PASS malformed/large PDFs, bounded concurrency and temporary-file cleanup');

  const start = Date.now();
  await assert.rejects(runLimitedExtraction('/bin/sh', ['-c', 'while :; do :; done'], 100));
  assert.ok(Date.now() - start < 3000, 'blocked child must not block API event loop');
  await assert.rejects(runLimitedExtraction('/usr/bin/yes', [], 1000));
  await assert.rejects(runLimitedExtraction('/bin/sh', ['-c', 'exit 7']));
  await assert.rejects(runLimitedExtraction('/missing-docgrid-parser', []));
  // An allocation beyond RLIMIT_AS fails in the child, leaving this process alive.
  await assert.rejects(runLimitedExtraction('/usr/bin/python3', ['-c', 'x=bytearray(512*1024*1024)']));
  assert.equal((await extractMaterialText('after.pdf', original)).status, 'READY');
  console.log('PASS timeout, output cap, child crash, missing executable and memory limit');

  const text = await extractMaterialText('large.txt', Buffer.from('я'.repeat(300000)));
  assert.equal(text.status, 'PARTIAL'); assert.equal(text.text.length, 200000);
  assert.equal((await extractMaterialText('bad.txt', Buffer.from([255]))).status, 'UNREAD');
  console.log('PASS bounded UTF-8 text and honest extraction status');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dg-office-test-'));
  try {
    const make=(name,entries)=>{
      const target=path.join(fixture,name);
      require('node:child_process').execFileSync('python3',['-c','import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()',target],{input:JSON.stringify(entries)});
      return fs.readFileSync(target);
    };
    const doc=make('proof.docx',{'word/document.xml':'<document><p><t>Договор поставки</t></p><tbl><p><t>Сумма 100 рублей</t></p></tbl></document>'});
    const parsed=await extractMaterialText('proof.docx',doc);assert.equal(parsed.status,'READY');assert.match(parsed.text,/Сумма 100 рублей/);
    const sheet=make('proof.xlsx',{'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Расчёт" r:id="r1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>','xl/sharedStrings.xml':'<sst><si><t>Долг</t></si></sst>','xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c><c r="C1"><f>B1*2</f></c></row></sheetData></worksheet>'});
    const cells=await extractMaterialText('proof.xlsx',sheet);assert.equal(cells.status,'PARTIAL');assert.match(cells.text,/Расчёт/);assert.match(cells.text,/A1: Долг/);assert.match(cells.text,/B1: 100/);
    const odt=make('proof.odt',{'content.xml':'<document><p>Текст ODT</p></document>'});assert.match((await extractMaterialText('proof.odt',odt)).text,/Текст ODT/);
    const entity=make('bad.docx',{'word/document.xml':'<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><document><p><t>&x;</t></p></document>'});assert.equal((await extractMaterialText('bad.docx',entity)).status,'UNREAD');
    const bomb=make('large.docx',{'word/document.xml':'x'.repeat(33*1024*1024)});assert.equal((await extractMaterialText('large.docx',bomb)).status,'UNREAD');
    assert.equal((await extractMaterialText('broken.docx',Buffer.from('invalid'))).status,'UNREAD');
    assert.equal((await extractMaterialText('scan.docx',make('scan.docx',{'word/document.xml':'<document><p><drawing/></p></document>'}))).reason,'office_no_text');
    console.log('PASS DOCX tables, XLSX cached values and incomplete formulas, ODT, malformed ZIP, expansion cap, DTD rejection and no OCR claims');
  } finally {fs.rmSync(fixture,{recursive:true,force:true});}

})().catch(error => { console.error(error); process.exitCode = 1; });


