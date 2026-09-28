import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

@Injectable()
export class S3Service {
  private client?: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('S3_BUCKET') ?? '';
    this.endpoint = (this.configService.get<string>('S3_ENDPOINT') ?? '').replace(/\/$/, '');
  }

  assertConfigured() {
    if (!this.endpoint || !this.bucket || !this.configService.get('S3_ACCESS_KEY_ID') || !this.configService.get('S3_SECRET_ACCESS_KEY')) {
      throw new InternalServerErrorException({ message: 'S3 endpoint/bucket/credentials are not configured.' });
    }
    const url = new URL(this.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new InternalServerErrorException({ message: 'S3 endpoint must be an HTTPS URL without credentials.' });
    }
  }

  private getClient() {
    this.assertConfigured();
    this.client ??= new S3Client({
      endpoint: this.endpoint,
      region: this.configService.get<string>('S3_REGION') || 'ru-1',
      forcePathStyle: this.configService.get<string>('S3_FORCE_PATH_STYLE') !== 'false',
      credentials: { accessKeyId: this.configService.get<string>('S3_ACCESS_KEY_ID')!, secretAccessKey: this.configService.get<string>('S3_SECRET_ACCESS_KEY')! },
      // S3-compatible services need not support AWS's optional checksum trailers.
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
    return this.client;
  }

  async putObject(buffer: Buffer, key: string, contentType: string): Promise<void> {
    try {
      await this.getClient().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: contentType }),
        { abortSignal: AbortSignal.timeout(120_000) });
    } catch (error) { this.failure('upload', error); }
  }

  async getObject(key: string, maxBytes = 500 * 1024 * 1024): Promise<Buffer> {
    try {
      const response = await this.getClient().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(120_000) });
      const body = response.Body;
      if (!body) throw new Error('Missing S3 body');
      const stream = body as AsyncIterable<Uint8Array> & { destroy?(): void };
      try {
        if (response.ContentLength !== undefined && response.ContentLength > maxBytes) throw new Error('S3 size limit');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new Error('S3 size limit');
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks, size);
      } finally { stream.destroy?.(); }
    } catch (error) { return this.failure('download', error); }
  }

  private failure(operation: string, error: unknown): never {
    if (error instanceof InternalServerErrorException) throw error;
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    // Preserve the exact missing-object response used by immutable export retries.
    throw new InternalServerErrorException({ message: `S3 ${operation} failed (${status || 'unavailable'}).` });
  }

  getPublicUrl(key: string): string {
    // This only builds an address; private objects still require authorization.
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

