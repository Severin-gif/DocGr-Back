import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { renderWorkspaceDocx } from './modules/docgrid/workspace-document-export';
import { normalizeDocumentContent, RICH_PREFIX } from './modules/docgrid/document-quality';
import { DocumentFileService } from './modules/document-workflow/document-file.service';

test('DOCX structure has real Word styles, A4, shared spacing and explicit inline emphasis', async () => {
  const bytes = await renderWorkspaceDocx(RICH_PREFIX + '<h1>Договор</h1><p>Преамбула</p><h2>1. Предмет</h2><p>1.1. Обязательство</p><p>а) Условие</p><p><b>100 рублей</b> <i>пояснение</i> <u>поле</u></p>');
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  const styles = await zip.file('word/styles.xml')!.async('string');
  for (const style of ['Heading1','Heading2','DocGridBody','DocGridPoint','DocGridSubpoint']) assert.ok(xml.includes(`w:val="${style}"`), style);
  assert.match(xml, /w:w="11906" w:h="16838"/);
  assert.match(xml, /w:left="1417"/);
  assert.match(styles, /w:line="276"/);
  assert.match(styles, /w:after="120"/);
  assert.match(styles, /w:keepNext/);
  assert.match(styles, /w:sz w:val="24"/);
  for (const value of ['100 рублей','пояснение','поле','1.1. Обязательство','а) Условие']) assert.ok(xml.includes(value));
  for (const tag of ['w:b','w:i','w:u']) assert.ok(xml.includes('<'+tag));
});

test('plain headings retain their level; nested decimal lists include Russian letter subpoints', async () => {
  const plain = await JSZip.loadAsync(await renderWorkspaceDocx('# Название\nПреамбула\n## 1. Предмет\n1.1. Пункт\nа) Подпункт'));
  const xml = await plain.file('word/document.xml')!.async('string');
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /w:pStyle w:val="DocGridPoint"/);
  assert.match(xml, /w:pStyle w:val="DocGridSubpoint"/);
  const lists = await JSZip.loadAsync(await renderWorkspaceDocx(RICH_PREFIX+'<ol><li>Раздел<ol><li>Пункт<ol><li>Подпункт</li></ol></li></ol></li></ol>'));
  const numbering = await lists.file('word/numbering.xml')!.async('string');
  assert.match(numbering, /w:val="%1.%2."/);
  assert.match(numbering, /w:numFmt w:val="russianLower"/);
});

test('generated document uses the same roles, preserving literal content without type templates', async () => {
  const files = new DocumentFileService({} as never);
  const bytes = await files.renderDocx({title:'Документ <А>',addressee:'Адресат',introduction:'Введение',sections:[{heading:'Раздел',paragraphs:['1.1. Текст 100 рублей'],tables:[{headers:['Сумма'],rows:[['100']]}]}],signatureBlock:['Подпись']});
  const zip = await JSZip.loadAsync(bytes), xml = await zip.file('word/document.xml')!.async('string');
  for (const style of ['Heading1','Heading2','DocGridAddress','DocGridPoint','DocGridSignature','DocGridTable']) assert.ok(xml.includes(`w:val="${style}"`),style);
  assert.match(xml, /Документ &lt;А&gt;/);
  assert.doesNotMatch(xml, /ПРОШУ|Предмет договора/);
  assert.equal(normalizeDocumentContent(RICH_PREFIX+'<p data-dg-role="note">Примечание</p>').includes('data-dg-role="note"'),true);
  assert.doesNotMatch(normalizeDocumentContent(RICH_PREFIX+'<p data-dg-role="unknown">Текст</p>'),/data-dg-role/);
});
