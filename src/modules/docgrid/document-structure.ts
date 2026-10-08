import { AlignmentType, type IStylesOptions } from 'docx';

/** Shared structure, not a contract/claim/content template. Dimensions are twips. */
export const DOCX_STRUCTURE_VERSION = 'docgrid-structure-v1';
export const DOCUMENT_ROLES = ['body', 'point', 'subpoint', 'note', 'address', 'signature'] as const;
export type DocumentRole = typeof DOCUMENT_ROLES[number];
export const DOCX_PAGE = {
  size: { width: 11906, height: 16838 },
  margin: { top: 1134, bottom: 1134, left: 1417, right: 1134 },
};
export const DOCUMENT_STYLE: Record<DocumentRole, string> = {
  body: 'DocGridBody', point: 'DocGridPoint', subpoint: 'DocGridSubpoint',
  note: 'DocGridNote', address: 'DocGridAddress', signature: 'DocGridSignature',
};
export function documentRole(value: string | undefined, text: string): DocumentRole {
  if (DOCUMENT_ROLES.includes(value as DocumentRole)) return value as DocumentRole;
  // Existing labels remain literal: no renumbering and no changes to references.
  if (/^\s*(?:\d+[.)]|\d+(?:\.\d+)+[.)]?)\s/.test(text)) return 'point';
  if (/^\s*[а-яёa-z][.)]\s/i.test(text)) return 'subpoint';
  return 'body';
}
export function documentStructureStyles(): IStylesOptions {
  const run = { font: 'Times New Roman', size: 24, color: '171A1D' };
  const paragraph = { spacing: { before: 0, after: 120, line: 276 } };
  const heading = { alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, spacing: { before: 240, after: 120, line: 276 }, keepNext: true, keepLines: true };
  return {
    default: {
      document: { run, paragraph },
      heading1: { run: { ...run, size: 32, bold: true }, paragraph: { ...heading, alignment: AlignmentType.CENTER, outlineLevel: 0 } },
      heading2: { run: { ...run, size: 26, bold: true }, paragraph: { ...heading, outlineLevel: 1 } },
      heading3: { run: { ...run, bold: true }, paragraph: { ...heading, outlineLevel: 2 } },
      heading4: { run: { ...run, bold: true }, paragraph: { ...heading, outlineLevel: 3 } },
      heading5: { run: { ...run, bold: true }, paragraph: { ...heading, outlineLevel: 4 } },
      heading6: { run: { ...run, bold: true }, paragraph: { ...heading, outlineLevel: 5 } },
    },
    paragraphStyles: [
      { id: 'DocGridBody', name: 'Основной текст', basedOn: 'Normal', next: 'DocGridBody', quickFormat: true, run, paragraph: { ...paragraph, alignment: AlignmentType.JUSTIFIED, indent: { firstLine: 709 } } },
      { id: 'DocGridPoint', name: 'Пункт', basedOn: 'DocGridBody', next: 'DocGridPoint', quickFormat: true, paragraph: { indent: { left: 709, hanging: 709, firstLine: 0 } } },
      { id: 'DocGridSubpoint', name: 'Подпункт', basedOn: 'DocGridBody', next: 'DocGridSubpoint', quickFormat: true, paragraph: { indent: { left: 1418, hanging: 709, firstLine: 0 } } },
      { id: 'DocGridNote', name: 'Примечание', basedOn: 'DocGridBody', next: 'DocGridBody', quickFormat: true, run: { italics: true }, paragraph: { indent: { firstLine: 0 } } },
      { id: 'DocGridAddress', name: 'Адресат', basedOn: 'DocGridBody', next: 'DocGridAddress', quickFormat: true, paragraph: { alignment: AlignmentType.RIGHT, indent: { firstLine: 0 } } },
      { id: 'DocGridSignature', name: 'Подпись', basedOn: 'DocGridBody', next: 'DocGridSignature', quickFormat: true, paragraph: { alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, keepLines: true } },
      { id: 'DocGridTable', name: 'Текст таблицы', basedOn: 'DocGridBody', next: 'DocGridTable', paragraph: { alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, spacing: { before: 0, after: 60, line: 276 } } },
    ],
  };
}
