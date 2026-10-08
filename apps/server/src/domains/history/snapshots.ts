import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TrackedFile } from '../tracked-files/tracked-files.ts';
import { BACKUP_NAME, STAMP } from './constants.ts';
import type { DiffBase, Snapshot } from './types.ts';

/**
 * Копии на диске: как их найти, как разобрать время и что взять базой сравнения.
 * Чтение файлов здесь же — дальше по конвейеру работают уже с текстом.
 */

/**
 * Время копии берём из ИМЕНИ, а не из mtime: имя фиксирует момент снятия копии
 * и не сбивается при перезаписи файла (копирование обновило бы mtime). По нему
 * же строится хронологический порядок ленты. Не разобралось — падаем на mtime.
 */
function parseStamp(stamp: string, fallbackMs: number): string {
  const match = STAMP.exec(stamp);
  if (!match) return new Date(fallbackMs).toISOString();
  const [, date, hh, mm, ss, ms] = match;
  return `${date}T${hh}:${mm}:${ss}.${ms}Z`;
}

/**
 * Копии одного целевого файла, отсортированные ПО ВОЗРАСТАНИЮ времени.
 * Ключ — `backupBase` цели (имя, под которым копия лежит на диске); в значении
 * только копии известных конфиг-файлов.
 */
export function collectSnapshots(
  backupDir: string,
  targets: TrackedFile[],
): Map<string, Snapshot[]> {
  const known = new Set(targets.map((target) => target.backupBase));
  const byFile = new Map<string, Snapshot[]>();

  if (!existsSync(backupDir)) return byFile;

  for (const name of readdirSync(backupDir)) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;

    const target = match[1] ?? name;
    // Только известные файлы конфигурации: копия постороннего файла (или папка
    // скилла) в ленту не попадает — читать произвольные пути мы не даём.
    if (!known.has(target)) continue;

    const path = join(backupDir, name);
    const stats = statSync(path);
    // Папки (копии скиллов) сюда не входят: история — про файлы конфигурации.
    if (stats.isDirectory()) continue;

    const list = byFile.get(target) ?? [];
    list.push({ name, path, at: parseStamp(match[2] ?? '', stats.mtimeMs) });
    byFile.set(target, list);
  }

  for (const list of byFile.values()) {
    // По возрастанию: старое сравнивается с новым, свежее — с текущим файлом.
    list.sort((a, b) => a.at.localeCompare(b.at));
  }

  return byFile;
}

/**
 * Что взять базой сравнения для копии по её индексу в отсортированном списке.
 *
 * Копия снимается ПЕРЕД записью, поэтому запись ленты с её временем — это
 * правка «копия → следующее состояние»: следующая копия, а у самой свежей —
 * текущий файл. Прежняя база «предыдущая копия → эта» показывала под каждым
 * временем правку, сделанную раньше, а предпоследняя правка файла не попадала
 * в ленту вовсе (живой случай: добавленное агентом право нигде не видно).
 */
export function resolveBase(snapshots: Snapshot[], index: number, currentPath: string): DiffBase {
  const next = snapshots[index + 1];
  if (next) return { basePath: next.path, label: 'next' };

  // Самая свежая копия сравнивается с текущим файлом на диске.
  return existsSync(currentPath)
    ? { basePath: currentPath, label: 'current' }
    : { label: 'initial' };
}

/**
 * Пара (старое, новое) для diffLines, чтобы «+/−» смотрели хронологически вперёд:
 * копия всегда старше своей базы — и текущего файла, и следующей копии.
 */
export function orderVersions(
  snapshotText: string,
  baseText: string,
): { before: string; after: string } {
  return { before: snapshotText, after: baseText };
}

export function readText(path?: string): string {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}
