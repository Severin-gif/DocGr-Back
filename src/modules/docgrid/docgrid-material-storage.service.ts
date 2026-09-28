import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { S3Service } from '../../common/s3/s3.service';

export type MaterialPayload = { bytes: Uint8Array | null; storage_key: string | null; byte_size: number; sha256: string };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

@Injectable()
export class DocGridMaterialStorageService {
  private readonly s3: S3Service;
  readonly enabled: boolean;
  constructor(config: ConfigService) {
    const mode = config.get<string>('DOCGRID_MATERIAL_STORAGE') || 'database';
    if (!['database', 's3'].includes(mode)) throw new Error('Invalid DOCGRID_MATERIAL_STORAGE');
    this.enabled = mode === 's3';
    // Dedicated credentials prevent changing the storage used by Legal Core ingestion.
    this.s3 = new S3Service(new ConfigService(Object.fromEntries(
      ['ENDPOINT', 'BUCKET', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'FORCE_PATH_STYLE']
        .map(key => [`S3_${key}`, config.get(`DOCGRID_S3_${key}`)]),
    )));
    if (this.enabled) this.s3.assertConfigured();
  }

  async store(projectId: string, bytes: Buffer, sha256: string, mime: string): Promise<string> {
    if (hash(bytes) !== sha256) throw new ConflictException({ code: 'SOURCE_INTEGRITY_FAILED' });
    // A fresh key is never reused or overwritten, including after an ambiguous retry.
    const key = `docgrid/materials/${projectId}/${randomUUID()}/${sha256}`;
    await this.s3.putObject(bytes, key, mime);
    const verified = await this.s3.getObject(key, bytes.length);
    if (verified.length !== bytes.length || hash(verified) !== sha256) throw new ConflictException({ code: 'SOURCE_INTEGRITY_FAILED' });
    return key;
  }

  async read(row: MaterialPayload): Promise<Buffer> {
    const bytes = row.storage_key ? await this.s3.getObject(row.storage_key, row.byte_size) : Buffer.from(row.bytes || []);
    return verifyMaterialBytes(row, bytes);
  }
}

export function verifyMaterialBytes(row: MaterialPayload, bytes: Buffer): Buffer {
  if (bytes.length !== row.byte_size || hash(bytes) !== row.sha256) throw new ConflictException({ code: 'SOURCE_INTEGRITY_FAILED' });
  return bytes;
}

export async function readMaterialBytes(row: MaterialPayload, storage?: DocGridMaterialStorageService): Promise<Buffer> {
  if (storage) return storage.read(row);
  if (row.storage_key) throw new Error('DocGrid object storage is unavailable');
  return verifyMaterialBytes(row, Buffer.from(row.bytes || []));
}

