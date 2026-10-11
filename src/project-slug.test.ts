import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSlug } from './modules/docgrid/project-slug';
test('project names become bounded Latin slugs', () => {
  assert.equal(projectSlug('Тимаева'), 'timaeva');
  assert.equal(projectSlug('  Дело № 42 / Ёж  '), 'delo-42-ezh');
  assert.equal(projectSlug('⚖️'), 'project');
  assert.equal(projectSlug('X'.repeat(200)), 'x'.repeat(64));
  assert.equal(projectSlug('а'.repeat(63) + '  б'), 'a'.repeat(63));
});
