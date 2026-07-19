import { existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { backupEntry, removeEntry } from '../lib/safe-io.ts';

/**
 * Резервные копии и откат к ним.
 *
 * Копии складывались с самого начала, но вернуть из них файл можно было только
 * руками — найти в каталоге нужную метку времени и скопировать поверх
 * оригинала. Для инструмента, который правит рабочий конфиг, это странно:
 * страховка есть, а воспользоваться ею нельзя, не выходя из панели.
 */

export interface BackupEntry {
  /** Имя файла копии — оно же идентификатор для отката. */
  name: string;
  /** К какому файлу конфигурации относится копия. */
  target: string;
  createdAt: string;
  sizeBytes: number;
  /**
   * Можно ли вернуть копию кнопкой.
   *
   * В каталоге лежат не только файлы конфигурации: удаление скилла кладёт туда
   * целую папку. Вернуть её `copyFileSync` нельзя, и предлагать кнопку, которая
   * заведомо ответит отказом, — обман. Такие копии показываются как есть, но
   * без кнопки: их разворачивают руками.
   */
  canRestore: boolean;
}

/** Имя копии: `<файл>.<метка времени>.bak`. Метка всегда одна и та же по форме. */
const BACKUP_NAME = /^(.+)\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.bak$/;

export function listBackups(
  backupDir: string,
  knownPaths: Record<string, string> = {},
): BackupEntry[] {
  if (!existsSync(backupDir)) return [];

  const entries: BackupEntry[] = [];

  for (const name of readdirSync(backupDir)) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;

    const path = join(backupDir, name);
    const stats = statSync(path);
    const target = match[1] ?? name;

    entries.push({
      name,
      target,
      createdAt: stats.mtime.toISOString(),
      sizeBytes: stats.size,
      // Папку (копию скилла) вернуть на место нечем, и цель должна быть
      // известна: копия постороннего файла восстановлению не подлежит.
      canRestore: !stats.isDirectory() && Boolean(resolveBackupTarget(target, knownPaths)),
    });
  }

  // Свежие сверху: откатываются обычно к последнему хорошему состоянию.
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Куда возвращать копию. Восстанавливать по имени из самой копии нельзя:
 * имя пришло из запроса, и `../` в нём увёл бы запись куда угодно. Поэтому
 * цель ищется в известном списке путей, а не собирается из строки.
 */
export function resolveBackupTarget(
  target: string,
  knownPaths: Record<string, string>,
): string | undefined {
  return Object.values(knownPaths).find((path) => basename(path) === target);
}

export interface RestoreResult {
  ok: boolean;
  /** Куда восстановили. */
  restoredTo?: string;
  /** Копия состояния, которое заменили: откат тоже должен быть обратимым. */
  backupPath?: string;
  error?: string;
}

/**
 * Откат файла к состоянию из копии.
 *
 * Перед заменой снимается копия текущего состояния — иначе откат сам стал бы
 * необратимой операцией, а это ровно то, от чего он спасает.
 */
export function restoreBackup(
  backupDir: string,
  name: string,
  knownPaths: Record<string, string>,
): RestoreResult {
  const entry = listBackups(backupDir, knownPaths).find((item) => item.name === name);
  if (!entry) return { ok: false, error: 'Копия не найдена' };

  const target = resolveBackupTarget(entry.target, knownPaths);
  if (!target) {
    return { ok: false, error: `Непонятно, куда возвращать копию «${entry.target}»` };
  }

  const backupPath = existsSync(target) ? backupEntry(target, backupDir) : undefined;

  copyFileSync(join(backupDir, name), target);
  return { ok: true, restoredTo: target, backupPath };
}

/** Удаление копии — на случай, когда в ней лежит то, чего быть на диске не должно. */
export function deleteBackup(backupDir: string, name: string): boolean {
  const entry = listBackups(backupDir).find((item) => item.name === name);
  if (!entry) return false;

  removeEntry(join(backupDir, name));
  return true;
}
