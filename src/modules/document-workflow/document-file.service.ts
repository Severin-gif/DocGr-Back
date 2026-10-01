import { ConflictException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableCell,
  TableRow,
  WidthType,
} from 'docx';
import { S3Service } from '../../common/s3/s3.service';
import type { StructuredLegalDocument } from './document-workflow.types';

const execFileAsync = promisify(execFile);

export type StoredVersionFiles = {
  docxObjectKey: string;
  pdfObjectKey: string;
  docxSize: number;
  pdfSize: number;
  checksum: string;
};

export type RecoverableVersionFiles = Omit<StoredVersionFiles, 'pdfObjectKey' | 'pdfSize'> & {
  pdfObjectKey: string | null; pdfSize: number | null; pdfHash: string | null; previewError: string | null;
};

@Injectable()
export class DocumentFileService {
  constructor(private readonly storage: S3Service) {}

  async createAndStore(
    ownerId: string,
    documentId: string,
    version: number,
    content: StructuredLegalDocument,
  ): Promise<StoredVersionFiles> {
    const docx = await this.renderDocx(content);
    const pdf = await this.convertDocxToPdf(docx);
    const root = `legal-documents/${ownerId}/${documentId}/v${version}`;
    const docxObjectKey = `${root}/document.docx`;
    const pdfObjectKey = `${root}/preview.pdf`;

    await this.storage.putObject(
      docx,
      docxObjectKey,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    await this.storage.putObject(pdf, pdfObjectKey, 'application/pdf');

    return {
      docxObjectKey,
      pdfObjectKey,
      docxSize: docx.length,
      pdfSize: pdf.length,
      checksum: createHash('sha256').update(docx).digest('hex'),
    };
  }

  /** Export the persisted canonical snapshot. A PDF failure preserves the DOCX.
   * Retries first read immutable object keys, including after a DB transaction rollback.
   * No document generation (or model call) is involved in this path.
   */
  async createAndStoreRecoverable(
    ownerId: string, documentId: string, version: number, content: StructuredLegalDocument,
    existing: { docxObjectKey?: string | null; pdfObjectKey?: string | null; generatePdf?: boolean; checksum?: string | null; pdfHash?: string | null } = {},
  ): Promise<RecoverableVersionFiles> {
    const root = `legal-documents/${ownerId}/${documentId}/v${version}`;
    const docxObjectKey = existing.docxObjectKey || `${root}/document.docx`;
    let docx = existing.docxObjectKey ? await this.storage.getObject(docxObjectKey) : await this.readOptional(docxObjectKey);
    if (!docx) {
      docx = await this.renderDocx(content);
      await this.storage.putObject(docx, docxObjectKey, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    }
    const checksum = createHash('sha256').update(docx).digest('hex');
    if (existing.checksum && checksum !== existing.checksum) throw new ConflictException('ARTIFACT_HASH_MISMATCH');
    const preserved = { docxObjectKey, docxSize: docx.length, checksum };
    if (existing.generatePdf === false && !existing.pdfObjectKey) return { ...preserved, pdfObjectKey: null, pdfSize: null, pdfHash: null, previewError: null };
    const pdfObjectKey = existing.pdfObjectKey || `${root}/preview.pdf`;
    try {
      let pdf = existing.pdfObjectKey ? await this.storage.getObject(pdfObjectKey) : await this.readOptional(pdfObjectKey);
      if (!pdf) {
        pdf = await this.convertDocxToPdf(docx);
        await this.storage.putObject(pdf, pdfObjectKey, 'application/pdf');
      }
      const pdfHash = createHash('sha256').update(pdf).digest('hex');
      if (existing.pdfHash && pdfHash !== existing.pdfHash) throw new ConflictException('ARTIFACT_HASH_MISMATCH');
      return { ...preserved, pdfObjectKey, pdfSize: pdf.length, pdfHash, previewError: null };
    } catch {
      // Converter output may contain local paths or untrusted document details; keep the public error bounded and neutral.
      return { ...preserved, pdfObjectKey: null, pdfSize: null, pdfHash: null, previewError: 'PREVIEW_FAILED: retry PDF export for this exact version' };
    }
  }

  private async readOptional(key: string): Promise<Buffer | null> {
    try { return await this.storage.getObject(key); }
    catch (error) {
      // Only a real missing object permits creating bytes; auth/network/storage failures never overwrite an object.
      if (error instanceof InternalServerErrorException) {
        const response = error.getResponse();
        const message = typeof response === 'string' ? response : (response as { message?: unknown }).message;
        if (message === 'S3 download failed (404).') return null;
      }
      throw error;
    }
  }

  async read(key: string): Promise<Buffer> {
    return this.storage.getObject(key);
  }

  async renderDocx(content: StructuredLegalDocument): Promise<Buffer> {
    const children: Array<Paragraph | Table> = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 220 },
        children: [new TextRun({ text: content.title, bold: true, size: 28 })],
      }),
    ];

    if (content.subtitle) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 260 },
        children: [new TextRun({ text: content.subtitle, italics: true, size: 22 })],
      }));
    }
    if (content.addressee) {
      children.push(new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { after: 240 },
        children: [new TextRun({ text: content.addressee, size: 22 })],
      }));
    }
    if (content.introduction) children.push(this.bodyParagraph(content.introduction));

    for (const section of content.sections) {
      if (section.heading) {
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: section.heading, bold: true, size: 24 })],
        }));
      }
      for (const paragraph of section.paragraphs) children.push(this.bodyParagraph(paragraph));
      for (const table of section.tables ?? []) {
        const rows: TableRow[] = [];
        const makeRow = (cells: string[], header: boolean) => new TableRow({
          tableHeader: header,
          children: cells.map(text => new TableCell({ children: [new Paragraph({
            spacing: { after: 60 }, children: [new TextRun({ text, bold: header, size: 22 })],
          })] })),
        });
        if (table.headers?.length) rows.push(makeRow(table.headers, true));
        table.rows.forEach(row => rows.push(makeRow(row, false)));
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      }
    }

    if (content.requests?.length) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 260, after: 100 },
        children: [new TextRun({ text: 'ПРОШУ:', bold: true, size: 24 })],
      }));
      content.requests.forEach((request, index) => children.push(new Paragraph({
        numbering: { reference: 'requests', level: 0 },
        spacing: { after: 100, line: 360 },
        children: [new TextRun({ text: request, size: 24 })],
      })));
    }

    for (const line of content.signatureBlock ?? []) {
      children.push(new Paragraph({
        spacing: { before: 180 },
        children: [new TextRun({ text: line, size: 24 })],
      }));
    }

    const document = new Document({
      numbering: {
        config: [{
          reference: 'requests',
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }],
        }],
      },
      sections: [{
        properties: {
          page: { margin: { top: 1134, right: 850, bottom: 1134, left: 1701 } },
        },
        children,
      }],
      styles: {
        default: {
          document: { run: { font: 'Times New Roman', size: 24 } },
        },
      },
    });
    return Packer.toBuffer(document);
  }

  private bodyParagraph(text: string): Paragraph {
    return new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: 709 },
      spacing: { after: 120, line: 360 },
      children: [new TextRun({ text, size: 24 })],
    });
  }

  async convertDocxToPdf(docx: Buffer): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), 'codex-document-'));
    const input = join(directory, `${randomUUID()}.docx`);
    const output = input.replace(/\.docx$/i, '.pdf');
    try {
      await writeFile(input, docx);
      await execFileAsync(
        process.env.LIBREOFFICE_BIN || 'soffice',
        [`-env:UserInstallation=${pathToFileURL(join(directory, 'profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', directory, input],
        { timeout: 45_000, maxBuffer: 1_000_000 },
      );
      return await readFile(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(`DOCX to PDF conversion failed: ${message.slice(0, 180)}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}


