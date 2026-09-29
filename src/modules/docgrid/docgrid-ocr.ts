import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
export const OCR_MAX_BYTES = 64 * 1024 * 1024;
export const OCR_MAX_PAGES = 1000;
export const OCR_MAX_TEXT = 2_000_000;
export const isOcrMaterial = (title: string) =>
  /\.(pdf|png|jpe?g|bmp|webp)$/i.test(title);
export type OcrPage = {
  page: number;
  text: string;
  method: string;
  status: string;
};
export type PageRange = {
  page: number;
  start: number;
  end: number;
  method: string;
  status: string;
};
// The subprocess has independent CPU, address-space and output ceilings. No shell.
export function runOcrCommand(
  command: string,
  args: string[],
  timeout = 60000,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "prlimit",
      [
        "--as=536870912",
        "--cpu=45",
        "--fsize=33554432",
        "--core=0",
        "--",
        command,
        ...args,
      ],
      {
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 512 * 1024,
        encoding: "utf8",
        env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      },
      (error, stdout) =>
        error ? reject(new Error("ocr_subprocess_failed")) : resolve(stdout),
    ),
  );
}
export async function pageCount(file: string, pdf: boolean) {
  if (!pdf) return 1;
  const info = await runOcrCommand("pdfinfo", [file], 10000);
  const count = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("invalid_page_count");
  return count;
}
export async function recognizePage(
  file: string,
  directory: string,
  page: number,
  pdf: boolean,
): Promise<OcrPage> {
  if (pdf) {
    const text = await runOcrCommand(
      "pdftotext",
      ["-f", String(page), "-l", String(page), "-enc", "UTF-8", file, "-"],
      15000,
    ).catch(() => "");
    const clean = text.replace(/\f/g, "").trim();
    if ((clean.match(/\p{L}/gu) || []).length >= 40)
      return { page, text: clean, method: "native", status: "READY" };
  }
  const image = pdf ? join(directory, "page.png") : file;
  try {
    if (pdf)
      await runOcrCommand("pdftoppm", [
        "-f",
        String(page),
        "-l",
        String(page),
        "-singlefile",
        "-scale-to",
        "2400",
        "-png",
        file,
        join(directory, "page"),
      ]);
    const text = (
      await runOcrCommand("tesseract", [
        image,
        "stdout",
        "-l",
        "rus+eng",
        "--psm",
        "3",
      ])
    ).trim();
    return { page, text, method: "ocr", status: text ? "READY" : "UNREAD" };
  } finally {
    if (pdf) await rm(image, { force: true });
  }
}
export function combinePages(pages: OcrPage[]) {
  let text = "";
  const ranges: PageRange[] = [];
  for (const p of [...pages].sort((a, b) => a.page - b.page)) {
    if (text.length) text += "\n\f\n";
    const start = text.length;
    text += p.text;
    ranges.push({
      page: p.page,
      start,
      end: text.length,
      method: p.method,
      status: p.status,
    });
  }
  return { text, ranges };
}
