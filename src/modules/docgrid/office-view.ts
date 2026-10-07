import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runLimitedExtraction, PDF_EXTRACTION_MAX_BYTES } from './docgrid-material-extraction';

let active = false;
export async function officeView(title: string, bytes: Buffer): Promise<unknown> {
  const kind = title.split('.').pop()?.toLowerCase();
  if (!kind || !['xls','xlsx','docx'].includes(kind)) throw new BadRequestException('Поддерживаются XLS, XLSX и DOCX');
  if (bytes.length > PDF_EXTRACTION_MAX_BYTES) throw new BadRequestException('Просмотр ограничен файлами до 32 МБ. Оригинал можно скачать.');
  if (active) throw new ServiceUnavailableException('Обработчик занят. Повторите открытие файла.');
  active = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'docgrid-office-view-'));
    const input = join(directory, 'source.' + kind);
    await writeFile(input, bytes, { mode: 0o600 });
    return JSON.parse(await runLimitedExtraction('python3', ['-I', resolve(__dirname, '../../../scripts/office-view.py'), input, kind]));
  } catch {
    throw new BadRequestException('Не удалось открыть офисный файл: повреждение, пароль или превышение лимита просмотра. Оригинал можно скачать.');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    active = false;
  }
}
