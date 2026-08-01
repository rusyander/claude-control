import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { writeTextFile } from '../../lib/safe-io.ts';
import type { TrackedFile } from '../tracked-files.ts';
import { BACKUP_NAME } from './constants.ts';
import { buildRevertedText, diffLines, isBinary, tooBig } from './diff.ts';
import { collectSnapshots, readText } from './snapshots.ts';
import type { RevertHunkResult } from './types.ts';

/**
 * Выборочный откат: вернуть ОДИН ханк из копии в текущий файл, не трогая
 * остального.
 *
 * Работает против ТЕКУЩЕГО файла на диске: дифф считается заново как
 * «копия → текущий файл», поэтому номер ханка совпадает с тем, что показан для
 * самой свежей копии (её дифф в ленте — ровно против текущего файла). Имя копии
 * приходит из запроса и проверяется как в buildDiff; цели — только известные
 * конфиг-файлы (файл секретов сюда не входит). Перед записью снимается копия
 * текущего состояния — откат тоже обратим.
 *
 * Копии файлов ПРОВАЙДЕРОВ откату не подлежат (`canRevert:false`) — отказываем до
 * любой записи. Это та же страховка, что и `canRestore:false` у полного отката
 * (Ф9-10): цель копии выводится по имени, и ошибка здесь означала бы запись
 * чужого конфига поверх файлов Claude.
 */
export function revertHunk(
  backupDir: string,
  name: string,
  hunkIndex: number,
  targets: TrackedFile[],
  backupTargetDir?: string,
): RevertHunkResult {
  if (basename(name) !== name || !BACKUP_NAME.test(name)) {
    return { ok: false, error: 'Копия не найдена' };
  }

  const byFile = collectSnapshots(backupDir, targets);
  for (const [file, snapshots] of byFile) {
    const snapshot = snapshots.find((item) => item.name === name);
    if (!snapshot) continue;

    const target = targets.find((item) => item.backupBase === file);
    if (!target) return { ok: false, error: 'Копия не найдена' };
    if (!target.canRevert) {
      return {
        ok: false,
        error: `Копия файла провайдера «${target.file}» доступна только для просмотра — откат отсюда не выполняется.`,
      };
    }

    const currentPath = target.path;
    if (!existsSync(currentPath)) {
      return { ok: false, error: 'Текущий файл не найден' };
    }

    const snapshotText = readText(snapshot.path);
    const currentText = readText(currentPath);

    if (isBinary(snapshotText) || isBinary(currentText)) {
      return { ok: false, error: 'Бинарный файл — построчный откат недоступен' };
    }
    if (tooBig(snapshotText, currentText)) {
      return { ok: false, error: 'Файл слишком большой — построчный откат недоступен' };
    }

    // before = копия, after = текущий файл: та же ориентация, что у диффа самой
    // свежей копии в ленте, поэтому индексы ханков совпадают.
    const { lines } = diffLines(snapshotText, currentText);
    const built = buildRevertedText(lines, hunkIndex, currentText);
    if (built === undefined) return { ok: false, error: 'Изменение не найдено' };
    if (built === currentText) return { ok: true, restoredTo: currentPath };

    const backupPath = writeTextFile(currentPath, built, { backupDir: backupTargetDir });
    return { ok: true, restoredTo: currentPath, backupPath };
  }

  return { ok: false, error: 'Копия не найдена' };
}
