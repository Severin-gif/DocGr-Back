import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const MATERIAL_TEXT_LIMIT = 200_000;
export const PDF_EXTRACTION_MAX_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 200;
let pdfActive = false;

export type MaterialExtraction = {
  text: string;
  status: 'READY' | 'PARTIAL' | 'UNREAD';
  reason: string;
};
const unread = (reason: string): MaterialExtraction => ({ text: '', status: 'UNREAD', reason });

/** Separate process: timeout also stops a parser that blocks its own event loop.
 * Linux address-space/CPU limits protect the API, not only the JavaScript heap.
 * Kept separate for real subprocess failure/timeout regression tests. */
export function runLimitedExtraction(command: string, args: string[], timeout = 8_000, maxBuffer = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('prlimit', ['--as=268435456', '--cpu=6', '--core=0', '--', command, ...args], {
      timeout, killSignal: 'SIGKILL', maxBuffer,
      encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Extraction is optional derived data. Never reject or alter an original
 * because a scanner, encrypted PDF or broken parser cannot produce text. */
export async function extractMaterialText(title: string, bytes: Buffer): Promise<MaterialExtraction> {
  if (/\.(txt|md)$/i.test(title)) {
    // Decode only a bounded prefix; four bytes cover every UTF-8 code point.
    const text = bytes.subarray(0, MATERIAL_TEXT_LIMIT * 4).toString('utf8').slice(0, MATERIAL_TEXT_LIMIT);
    if (text.includes('\uFFFD')) return unread('invalid_utf8');
    return { text, status: bytes.length > Buffer.byteLength(text) ? 'PARTIAL' : 'READY', reason: 'text' };
  }
  if (/\.(docx|xlsx|xls|doc|odt)$/i.test(title)) return extractOfficeText(title, bytes);
  if (!/\.pdf$/i.test(title) || bytes.subarray(0, 5).toString() !== '%PDF-') return unread('unsupported');
  if (bytes.length > PDF_EXTRACTION_MAX_BYTES) return unread('pdf_size_limit');
  if (pdfActive) return unread('pdf_busy');
  pdfActive = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'docgrid-extract-'));
    const input = join(directory, 'source.pdf');
    await writeFile(input, bytes, { mode: 0o600 });
    // poppler-utils is already part of the runtime image. Do not fall back to
    // in-process pdf-parse if either executable is unavailable.
    const text = await runLimitedExtraction('pdftotext', ['-enc', 'UTF-8', '-f', '1', '-l', String(MAX_PAGES), input, '-']);
    if (!text.trim()) return unread('pdf_no_text');
    const partial = text.length > MATERIAL_TEXT_LIMIT || (text.match(/\f/g)?.length ?? 0) >= MAX_PAGES;
    return { text: text.slice(0, MATERIAL_TEXT_LIMIT), status: partial ? 'PARTIAL' : 'READY', reason: 'pdf' };
  } catch (error) {
    const failure = error as { killed?: boolean; code?: string | number };
    return unread(failure.killed ? 'pdf_timeout' : failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'pdf_output_limit' : 'pdf_failed');
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    finally { pdfActive = false; }
  }
}



async function extractOfficeText(title: string, bytes: Buffer): Promise<MaterialExtraction> {
  if (bytes.length > PDF_EXTRACTION_MAX_BYTES) return unread('office_size_limit');
  if (pdfActive) return unread('office_busy');
  pdfActive = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'docgrid-extract-'));
    const kind = title.split('.').pop()!.toLowerCase(), input = join(directory, 'source.' + kind);
    await writeFile(input, bytes, {mode:0o600});
    const output = kind === 'doc'
      ? {text:await runLimitedExtraction('antiword',['-m','UTF-8.txt',input]),partial:false}
      : JSON.parse(await runLimitedExtraction('python3',['-I',resolve(__dirname,'../../../scripts/extract-office.py'),input,kind]));
    if (typeof output.text !== 'string' || !output.text.trim()) return unread('office_no_text');
    return {text:output.text.slice(0,MATERIAL_TEXT_LIMIT),status:output.partial||output.text.length>MATERIAL_TEXT_LIMIT?'PARTIAL':'READY',reason:'office'};
  } catch(error) {
    return unread((error as {killed?:boolean}).killed?'office_timeout':'office_failed');
  } finally {
    try { if(directory) await rm(directory,{recursive:true,force:true}).catch(()=>undefined); }
    finally { pdfActive=false; }
  }
}
