import { statSync } from 'node:fs';
import type { ProjectFileSaveResult } from '@agentdeck/contracts';
import { writeTextFile } from '../../lib/safe-io.ts';
import { MAX_FILE_BYTES } from './constants.ts';
import { ProjectFileError, resolveProjectPath } from './paths.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Запись правки человека в файл проекта.
 *
 * Это единственное место, где панель пишет за пределами своих каталогов,
 * поэтому страховок три, и все обязательные:
 *
 *  1. Путь проходит ту же проверку обхода каталога, что и разделы чужих CLI.
 *  2. Прежняя версия уходит в копии панели — правку можно отменить из раздела
 *     резервных копий, как любую другую.
 *  3. Файл на диске сверяется по времени записи. Агент пишет в тот же файл
 *     параллельно, и «сохранить» поверх его работы, ничего не спросив, —
 *     потерять её молча. Разошлось — отказ 409, решает человек.
 */
export class StaleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleFileError';
  }
}

export function saveProjectFile(
  root: string,
  file: string,
  content: string,
  expectedMtimeMs: number,
  backupDir?: string,
): ProjectFileSaveResult {
  if (typeof content !== 'string')
    throw coded(new ProjectFileError('Содержимое не передано.'), 'file-content-missing');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw coded(new ProjectFileError('Файл больше допустимого размера.'), 'file-too-large-write');
  }

  const path = resolveProjectPath(root, file);
  const stats = statSync(path);
  if (!stats.isFile()) throw coded(new ProjectFileError('Это не файл.'), 'file-not-a-file');

  // Сравнение целочисленное: mtimeMs приходит от клиента через JSON, и дробная
  // часть по дороге теряет точность — из-за неё файл «менялся» бы всегда.
  if (Math.floor(stats.mtimeMs) !== Math.floor(expectedMtimeMs)) {
    throw coded(
      new StaleFileError('Файл на диске изменился после открытия.'),
      'file-changed-on-disk',
    );
  }

  const backupPath = writeTextFile(path, content, {
    backupDir,
    // Имя копии — весь путь от корня проекта: иначе `index.ts` из разных папок
    // ложились бы в одну ротацию и вытесняли друг друга.
    backupName: file.split('/').join('__'),
  });

  const after = statSync(path);
  return { mtimeMs: after.mtimeMs, sizeBytes: after.size, backupPath };
}
