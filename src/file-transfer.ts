import { Readable, Transform } from 'node:stream';

export const MAX_MATERIAL_BYTES = 500 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = MAX_MATERIAL_BYTES + 1024 * 1024;

export function byteLimit(maxBytes: number) {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(Object.assign(new Error('File transfer exceeds limit'), { status: 413 }));
      else callback(null, chunk);
    },
  });
}

export function uploadStream(source: Readable, maxBytes = MAX_MULTIPART_BYTES) {
  const limiter = byteLimit(maxBytes);
  source.on('error', error => limiter.destroy(error));
  // pipe applies backpressure; never copy an entire multipart body into a Blob.
  source.pipe(limiter);
  return limiter;
}
