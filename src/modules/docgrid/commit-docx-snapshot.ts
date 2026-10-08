import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DOCX_STRUCTURE_VERSION } from './document-structure';
import { renderWorkspaceDocx } from './workspace-document-export';

type Snapshot = {
  docx_bytes?: Uint8Array | null;
  docx_sha256?: string | null;
  format_version?: string | null;
};

// Call inside a transaction. The shared commit lock serializes lazy conversion.
export async function commitDocxSnapshot(db: any, documentId: string, commitId: string | null, content: string, existing?: Snapshot) {
  let snapshot = existing;
  if (commitId) {
    const [commit] = await db.$queryRaw`
      SELECT after_content, docx_bytes, docx_sha256, format_version
      FROM docgrid.docgrid_commits
      WHERE id=${commitId}::uuid AND document_id=${documentId}::uuid FOR UPDATE
    `;
    if (!commit || commit.after_content !== content) {
      throw new ConflictException('Содержимое ветки не совпадает с редакцией коммита');
    }
    snapshot = commit.docx_bytes ? commit : existing;
  }
  const bytes = snapshot?.docx_bytes ? Buffer.from(snapshot.docx_bytes) : await renderWorkspaceDocx(content);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const version = snapshot?.docx_bytes ? snapshot.format_version : DOCX_STRUCTURE_VERSION;
  if (snapshot?.docx_bytes && digest !== snapshot.docx_sha256) {
    throw new ConflictException('Контрольная сумма DOCX не совпадает');
  }
  if (commitId) {
    await db.$executeRaw`
      UPDATE docgrid.docgrid_commits SET docx_bytes=${bytes}, docx_sha256=${digest}, format_version=${version}
      WHERE id=${commitId}::uuid AND docx_bytes IS NULL
    `;
  }
  return { bytes, digest, version };
}
