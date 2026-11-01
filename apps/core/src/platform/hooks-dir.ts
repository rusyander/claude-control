import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { absent, readFact } from '../lib/facts/read-fact.ts';
import { writeExecutable } from './exec-bit.ts';
import { currentOs, type OsKind } from './os-kind.ts';

/**
 * Каталог хуков ядра на диске (05 §Push closure): `<coreHome>/hooks/<taskId>/<unitId>`, файлы
 * 0755 с чтением режима назад (P105, `exec-bit.ts`). Отпечаток — sha256 по именам и содержимому
 * в порядке имён: сверка дрейфа в конце шага видит и правку, и лишний, и пропавший файл.
 */

export function fingerprintFiles(files: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\0`);
  return hash.digest('hex');
}

/** Записать скрипты; первый отказ записи или режима — исключение с именем файла. */
export function writeHooksDir(
  dir: string,
  scripts: Readonly<Record<string, string>>,
  os: OsKind = currentOs(),
): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(scripts)) {
    const done = writeExecutable(join(dir, name), text, os);
    if (!done.ok) throw new Error(`hook ${name}: ${done.reason}`);
  }
  return fingerprintFiles(scripts);
}

/** Отпечаток каталога как он лежит сейчас; нет каталога — «нет», сбой чтения — `unknown`. */
export function readHooksDirFp(dir: string): Promise<Fact<string>> {
  return readFact('git.worktree-config', () => {
    const stats = statSync(dir, { throwIfNoEntry: false });
    if (!stats) return absent();
    const files: Record<string, string> = {};
    for (const name of readdirSync(dir)) files[name] = readFileSync(join(dir, name), 'utf8');
    return fingerprintFiles(files);
  });
}
