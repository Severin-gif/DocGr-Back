import { ConflictException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { documentRole } from '../docgrid/document-structure';
import { renderWorkspaceDocx } from '../docgrid/workspace-document-export';
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
    // Same roles and page styles as manual revisions; no document-type template here.
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const paragraph = (text: string, role = documentRole(undefined, text)) => `<p data-dg-role="${role}">${escape(text).replace(/\n/g, '<br>')}</p>`;
    const blocks = ['<h1>' + escape(content.title) + '</h1>'];
    if (content.subtitle) blocks.push(paragraph(content.subtitle, 'note'));
    if (content.addressee) blocks.push(paragraph(content.addressee, 'address'));
    if (content.introduction) blocks.push(paragraph(content.introduction));
    for (const section of content.sections) {
      if (section.heading) blocks.push('<h2>' + escape(section.heading) + '</h2>');
      blocks.push(...section.paragraphs.map(text => paragraph(text)));
      for (const table of section.tables ?? []) {
        const row = (cells: string[], tag: 'td' | 'th') => '<tr>' + cells.map(text => `<${tag}>${escape(text)}</${tag}>`).join('') + '</tr>';
        blocks.push('<table>' + (table.headers?.length ? row(table.headers, 'th') : '') + table.rows.map(cells => row(cells, 'td')).join('') + '</table>');
      }
    }
    if (content.requests?.length) {
      blocks.push('<h2>ПРОШУ:</h2><ol>' + content.requests.map(text => '<li>' + escape(text) + '</li>').join('') + '</ol>');
    }
    blocks.push(...(content.signatureBlock ?? []).map(text => paragraph(text, 'signature')));
    return renderWorkspaceDocx('<!-- docgrid-richtext-v1 -->' + blocks.join(''));
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
