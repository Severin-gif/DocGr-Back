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

const xmlBlocks = (xml: string, tag: string) => xml.match(new RegExp(`<w:${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/w:${tag}>`, 'g')) ?? [];
async function docxXml(content: string) {
  const zip = await JSZip.loadAsync(await renderWorkspaceDocx(content));
  return {
    document: await zip.file('word/document.xml')!.async('string'),
    styles: await zip.file('word/styles.xml')!.async('string'),
    numbering: await zip.file('word/numbering.xml')!.async('string'),
  };
}

test('literal numeric clauses use hanging point style in rich and legacy plain documents', async () => {
  const clauses = ['1. Условия', '2) Оплата', '  3. Поставка', '1.1. Обязательство', '1.2 Подробности'];
  const lines = [...clauses, '100 рублей', '2026 год', 'Обычный текст'];
  for (const input of [lines.join('\n'), RICH_PREFIX + lines.map(text => `<p>${text}</p>`).join('')]) {
    const xml = await docxXml(input), paragraphs = xmlBlocks(xml.document, 'p');
    assert.equal(paragraphs.length, lines.length);
    paragraphs.forEach((p, i) => {
      assert.ok(p.includes(lines[i]), 'literal text is unchanged');
      assert.match(p, new RegExp(`w:pStyle w:val="${i < clauses.length ? 'DocGridPoint' : 'DocGridBody'}"`));
      assert.doesNotMatch(p, /<w:numPr>/, 'literal labels are not renumbered');
    });
    const point = xmlBlocks(xml.styles, 'style').find(s => s.includes('w:styleId="DocGridPoint"'))!;
    assert.match(point, /<w:ind[^>]*w:left="709"[^>]*w:hanging="709"/);
  }
  const explicit = await docxXml(RICH_PREFIX + '<h2>1. Предмет</h2><p data-dg-role="note">2) Примечание</p>');
  assert.match(xmlBlocks(explicit.document, 'p')[0]!, /w:pStyle w:val="Heading2"/);
  assert.match(xmlBlocks(explicit.document, 'p')[1]!, /w:pStyle w:val="DocGridNote"/);
});

test('mixed lists restart new counters at zero while preserving visual nesting and ordered hierarchy', async () => {
  const xml = await docxXml(RICH_PREFIX + '<ul><li>Маркер<ol><li>Первый<p>Продолжение</p><ol><li>Второй уровень</li></ol></li><li>Следующий</li></ol></li></ul><ol><li>Новый список</li></ol>');
  const paragraphs = xmlBlocks(xml.document, 'p');
  const item = (text: string) => paragraphs.find(p => p.includes(`>${text}</w:t>`))!;
  const numId = (p: string) => /<w:numId w:val="(\d+)"/.exec(p)![1];
  const first = item('Первый'), nested = item('Второй уровень');
  assert.match(first, /w:ilvl w:val="0"/);
  assert.match(first, /<w:ind[^>]*w:left="1418"/);
  assert.match(nested, /w:ilvl w:val="1"/);
  assert.match(nested, /<w:ind[^>]*w:left="2127"/);
  assert.equal(numId(first), numId(nested));
  assert.equal(numId(first), numId(item('Следующий')));
  assert.notEqual(numId(first), numId(item('Маркер')));
  assert.notEqual(numId(first), numId(item('Новый список')));
  const continuation = item('Продолжение');
  assert.doesNotMatch(continuation, /<w:numPr>/);
  assert.match(continuation, /<w:ind[^>]*w:left="1418"/);
  const concrete = xmlBlocks(xml.numbering, 'num').find(n => n.includes(`w:numId="${numId(first)}"`))!;
  const abstractId = /<w:abstractNumId w:val="(\d+)"/.exec(concrete)![1];
  const definition = xmlBlocks(xml.numbering, 'abstractNum').find(n => n.includes(`w:abstractNumId="${abstractId}"`))!;
  const levels = xmlBlocks(definition, 'lvl');
  assert.match(levels[0]!, /w:lvlText w:val="%1\."/);
  assert.match(levels[1]!, /w:lvlText w:val="%1\.%2\."/);
  assert.match(levels[2]!, /w:numFmt w:val="russianLower"/);

  const reverse = await docxXml(RICH_PREFIX + '<ol><li>Внешний<ul><li>Маркер внутри<ol><li>Новый счётчик</li></ol></li></ul></li></ol>');
  const restarted = xmlBlocks(reverse.document, 'p').find(p => p.includes('Новый счётчик'))!;
  assert.match(restarted, /w:ilvl w:val="0"/);
  assert.match(restarted, /<w:ind[^>]*w:left="2127"/);
});

test('table headers are bold and only consecutive leading header rows repeat', async () => {
  const xml = await docxXml(RICH_PREFIX + '<table><thead><tr><th colspan="2"><p>Общий заголовок</p></th></tr><tr><th><i>Название</i></th><th><span style="font-weight: normal">Без жирного</span></th></tr></thead><tbody><tr><td>Значение</td><td>100</td></tr><tr><th>Поздний заголовок</th><td>200</td></tr></tbody></table>');
  const rows = xmlBlocks(xml.document, 'tr');
  assert.equal(rows.length, 4);
  for (const row of rows.slice(0, 2)) assert.match(row, /<w:tblHeader(?:\s[^>]*)?\/>/);
  for (const row of rows.slice(2)) assert.doesNotMatch(row, /<w:tblHeader/);
  assert.match(rows[0], /<w:gridSpan w:val="2"/);
  const run = (text: string) => xmlBlocks(xml.document, 'r').find(r => r.includes(`>${text}</w:t>`))!;
  assert.match(run('Общий заголовок'), /<w:b\/>/);
  assert.match(run('Название'), /<w:b\/>/);
  assert.match(run('Название'), /<w:i\/>/);
  assert.match(run('Поздний заголовок'), /<w:b\/>/);
  assert.doesNotMatch(run('Значение'), /<w:b/);
  assert.match(run('Без жирного'), /<w:b w:val="false"/);
  for (const p of xmlBlocks(xml.document, 'p')) assert.match(p, /w:pStyle w:val="DocGridTable"/);
});

test('generated multi-page table keeps a repeating bold header without marking body rows', async () => {
  const files = new DocumentFileService({} as never);
  const bytes = await files.renderDocx({ title: 'Таблица', sections: [{ paragraphs: ['1. Условия', '2) Оплата'], tables: [{ headers: ['Наименование', 'Сумма'], rows: Array.from({ length: 150 }, (_, i) => [`Строка ${i + 1}`, String(i)]) }] }] });
  const zip = await JSZip.loadAsync(bytes), xml = await zip.file('word/document.xml')!.async('string');
  const rows = xmlBlocks(xml, 'tr');
  assert.equal(rows.length, 151);
  assert.match(rows[0], /<w:tblHeader/);
  for (const run of xmlBlocks(rows[0], 'r')) assert.match(run, /<w:b\/>/);
  for (const row of rows.slice(1)) assert.doesNotMatch(row, /<w:tblHeader|<w:b/);
  for (const text of ['1. Условия', '2) Оплата']) assert.match(xmlBlocks(xml, 'p').find(p => p.includes(text))!, /w:pStyle w:val="DocGridPoint"/);
});
