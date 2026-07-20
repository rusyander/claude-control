import { existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { backupEntry, removeEntry, copyRecursive } from '../lib/safe-io.ts';

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
   * Можно ли вернуть копию кнопкой. Файл конфигурации возвращается по месту;
   * папка (копия скилла) разворачивается рекурсивно в каталог skills/. Кнопки
   * нет только у копий, чью цель некуда вернуть (посторонний файл).
   */
  canRestore: boolean;
}

/** Имя копии: `<файл>.<метка времени>.bak`. Метка всегда одна и та же по форме. */
const BACKUP_NAME = /^(.+)\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.bak$/;

export function listBackups(
  backupDir: string,
  knownPaths: Record<string, string> = {},
  skillsDir?: string,
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
      // Цель должна быть известна: копия постороннего файла восстановлению не
      // подлежит. Папку скилла возвращаем в skills/ (см. resolveBackupTarget).
      canRestore: Boolean(resolveBackupTarget(target, stats.isDirectory(), knownPaths, skillsDir)),
    });
  }

  // Свежие сверху: откатываются обычно к последнему хорошему состоянию.
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Куда возвращать копию. Имя пришло из запроса, поэтому цель не собирается из
 * строки, а выводится безопасно:
 *
 *   файл — ищется в известном списке путей по basename;
 *   папка — это копия скилла с именем `<родитель>-<id>` (skills-… или
 *     skills-disabled-…). Снимаем известный префикс и возвращаем в активный
 *     каталог skills/<id>. `id` обязан быть одним безопасным сегментом — иначе
 *     `../` увёл бы запись наружу.
 */
export function resolveBackupTarget(
  target: string,
  isDirectory: boolean,
  knownPaths: Record<string, string>,
  skillsDir?: string,
): string | undefined {
  if (isDirectory) {
    if (!skillsDir) return undefined;
    let id: string | undefined;
    if (target.startsWith('skills-disabled-')) id = target.slice('skills-disabled-'.length);
    else if (target.startsWith('skills-')) id = target.slice('skills-'.length);
    if (!id || /[\\/]/.test(id) || id.includes('..')) return undefined;
    return join(skillsDir, id);
  }
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
  skillsDir?: string,
): RestoreResult {
  const source = join(backupDir, name);
  if (!BACKUP_NAME.test(name) || !existsSync(source))
    return { ok: false, error: 'Копия не найдена' };

  const entry = listBackups(backupDir, knownPaths, skillsDir).find((item) => item.name === name);
  if (!entry) return { ok: false, error: 'Копия не найдена' };

  const isDirectory = statSync(source).isDirectory();
  const target = resolveBackupTarget(entry.target, isDirectory, knownPaths, skillsDir);
  if (!target) {
    return { ok: false, error: `Непонятно, куда возвращать копию «${entry.target}»` };
  }

  // Перед заменой снимаем копию текущего состояния — откат тоже обратим.
  const backupPath = existsSync(target) ? backupEntry(target, backupDir, entry.target) : undefined;

  if (isDirectory) {
    // Папку разворачиваем целиком: сперва убираем прежнюю, чтобы не смешать
    // старые и новые файлы, затем копируем рекурсивно.
    removeEntry(target);
    copyRecursive(source, target);
  } else {
    copyFileSync(source, target);
  }

  return { ok: true, restoredTo: target, backupPath };
}

/** Удаление копии — на случай, когда в ней лежит то, чего быть на диске не должно. */
export function deleteBackup(backupDir: string, name: string): boolean {
  const entry = listBackups(backupDir).find((item) => item.name === name);
  if (!entry) return false;

  removeEntry(join(backupDir, name));
  return true;
}
