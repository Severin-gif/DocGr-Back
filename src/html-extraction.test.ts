import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMaterialText, MATERIAL_TEXT_LIMIT } from './modules/docgrid/docgrid-material-extraction';

// Exercise the real bounded Python subprocess used by material uploads.
const extract = (html: string) => extractMaterialText('evidence.html', Buffer.from(html));

test('HTML extraction suppresses nested excluded elements without losing visible text', async t => {
  const fixtures = [
    ['nested templates', '<template><template>inner</template>LEAK</template>'],
    ['three template levels', '<template>outer<template><template>inner</template>middle</template>LEAK</template>'],
    ['script inside a template', '<template><script>const value = "<template>";</script>LEAK</template>'],
    ['style inside a template', '<template><style>p::before { content: "<template>"; }</style>LEAK</template>'],
    ['mixed head, script, style and templates', '<template><head><script>hidden command</script><style>.hidden { color: red; }</style></head><div><template>inner</template>LEAK</div></template>'],
    ['ordinary tags inside templates', '<template><div><p>hidden</p><table><tr><td><template>inner</template>LEAK</td></tr></table></div></template>'],
    ['sibling excluded elements', '<template><template>inner</template>LEAK</template><script>hidden</script><style>hidden</style>'],
    ['self-closing excluded elements', '<template><template/>LEAK<script/><style/></template><template/><script/><style/>'],
    ['unmatched closing tags', '<template><template>inner</style></script></head></template>LEAK</template>'],
  ];
  for (const [name, hidden] of fixtures) {
    await t.test(name, async () => {
      assert.deepEqual(await extract(`До${hidden}После`), { text: 'ДоПосле', status: 'READY', reason: 'html' });
    });
  }
  for (const tag of ['head', 'iframe', 'object', 'svg', 'math']) {
    await t.test(`nested templates inside ${tag}`, async () => {
      assert.deepEqual(await extract(`До<${tag}><template><template>inner</template>LEAK</template>hidden</${tag}>После`),
        { text: 'ДоПосле', status: 'READY', reason: 'html' });
    });
  }
});

test('HTML extraction preserves entities, Unicode, block breaks and table cells', async () => {
  const html = '<h1>Решение 😀</h1><p>Долг &amp; проценты &lt; 100&nbsp;₽<br>Срок</p>'
    + '<!-- technical comment --><template><template>inner</template>LEAK</template>'
    + '<table><tr><th>Статья</th><th>Сумма</th></tr><tr><td>Долг</td><td>100</td></tr></table><p>Конец</p>';
  assert.deepEqual(await extract(html), {
    text: 'Решение 😀\n\nДолг & проценты < 100\u00a0₽\nСрок\n\n\nСтатья\tСумма\t\n\nДолг\t100\t\n\n\nКонец',
    status: 'READY', reason: 'html',
  });
});

test('HTML hidden nesting survives the 64 KiB parser feed boundary', async () => {
  const html = 'До<template><template>' + 'hidden'.repeat(12_000) + '</template>LEAK</template>После';
  assert.deepEqual(await extract(html), { text: 'ДоПосле', status: 'READY', reason: 'html' });
});

test('HTML hidden content does not consume the visible output budget', async () => {
  const visible = 'Я'.repeat(MATERIAL_TEXT_LIMIT - 10) + 'Конец';
  const html = '<template><template>' + 'x'.repeat(MATERIAL_TEXT_LIMIT + 1) + '</template>LEAK</template><span>' + visible + '</span>';
  assert.deepEqual(await extract(html), { text: visible, status: 'READY', reason: 'html' });
  const partial = await extract('<span>' + 'Я'.repeat(MATERIAL_TEXT_LIMIT + 1) + '</span>');
  assert.deepEqual(partial, { text: 'Я'.repeat(MATERIAL_TEXT_LIMIT), status: 'PARTIAL', reason: 'html' });
});

test('HTML with only hidden content remains UNREAD and an unclosed hidden parent stays hidden', async () => {
  assert.deepEqual(await extract('<template><template>inner</template>LEAK<script>command</script><style>css</style></template>'),
    { text: '', status: 'UNREAD', reason: 'html_no_text' });
  assert.deepEqual(await extract('До<template><template>inner</template>LEAK'),
    { text: 'До', status: 'READY', reason: 'html' });
});
