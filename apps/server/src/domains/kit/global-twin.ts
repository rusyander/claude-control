import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KitGlobalItem, KitTwinKind } from '@agentdeck/contracts/kit';
import {
  backupEntry,
  copyRecursive,
  removeEntry,
  writeTextFile,
} from '../../lib/safe-io/safe-io.ts';
import { describe, listFiles, readText } from './items.ts';

/**
 * Набор панели ↔ глобальный слой человека (`~/.claude`): сверка одноимённых
 * навыков, команд и субагентов и перенос в обе стороны.
 *
 * В набор — копией «моё»: встроенный файл не трогается, прежняя копия уходит в
 * архив набора. В глобальный слой — только по кнопке человека и только после
 * резервной копии того, что там лежало: это настоящая конфигурация, и правка
 * панели не должна стать необратимой.
 */

/** Корень элемента внутри набора: навык — папкой (с соседними файлами), остальное — файлом. */
export function twinRoot(kind: KitTwinKind, name: string): string {
  if (kind === 'skill') return `skills/${name}`;
  return `${kind === 'command' ? 'commands' : 'agents'}/${name}.md`;
}

/** Главный файл элемента — его текст сравнивается и показывается. */
export function twinMain(kind: KitTwinKind, name: string): string {
  return kind === 'skill' ? `skills/${name}/SKILL.md` : twinRoot(kind, name);
}

/** Тексты равны без учёта концов строк и пробелов в конце строк. */
export function sameText(a: string, b: string): boolean {
  const norm = (text: string) =>
    text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  return norm(a) === norm(b);
}

/** Навыки, команды и субагенты глобального слоя (команды и субагенты — верхний уровень). */
export function listGlobal(globalDir: string): Omit<KitGlobalItem, 'description'>[] {
  const out: Omit<KitGlobalItem, 'description'>[] = [];
  const skills = join(globalDir, 'skills');
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills, { withFileTypes: true })) {
      const main = join(skills, entry.name, 'SKILL.md');
      if (entry.isDirectory() && existsSync(main)) {
        out.push({ kind: 'skill', name: entry.name, path: main });
      }
    }
  }
  for (const kind of ['command', 'agent'] as const) {
    const dir = join(globalDir, kind === 'command' ? 'commands' : 'agents');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push({ kind, name: entry.name.slice(0, -3), path: join(dir, entry.name) });
      }
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export function globalItems(globalDir: string): KitGlobalItem[] {
  return listGlobal(globalDir).map((item) => ({
    ...item,
    description: describe(readText(item.path)),
  }));
}

export interface TwinDirs {
  builtinDir: string;
  mineDir: string;
  globalDir: string;
}

/**
 * Текст элемента, который получает прогон: копия «моё», иначе встроенный.
 * Для навыка — главный файл; соседние файлы собирает `effectiveFiles`.
 */
export function effectiveText(dirs: TwinDirs, rel: string): string {
  const mine = join(dirs.mineDir, rel);
  return existsSync(mine) ? readText(mine) : readText(join(dirs.builtinDir, rel));
}

/** Все файлы элемента в том виде, в каком их получает прогон: встроенные, поверх — «моё». */
function effectiveFiles(dirs: TwinDirs, kind: KitTwinKind, name: string): Map<string, string> {
  const root = twinRoot(kind, name);
  const files = new Map<string, string>();
  for (const base of [dirs.builtinDir, dirs.mineDir]) {
    if (kind === 'skill') {
      for (const rel of listFiles(join(base, root))) files.set(rel, join(base, root, rel));
    } else if (existsSync(join(base, root))) {
      files.set('', join(base, root));
    }
  }
  return files;
}

/**
 * «В глобальный»: элемент набора ложится в `~/.claude` тем же путём. Что там
 * лежало — сначала в резервную копию панели (видна в «Истории»), затем
 * заменяется целиком: смесь старых и новых файлов навыка была бы третьей
 * версией, которой нет ни там, ни здесь. Возвращает путь копии, если она была.
 */
export function exportToGlobal(
  dirs: TwinDirs,
  backupDir: string,
  kind: KitTwinKind,
  name: string,
): string | undefined {
  const files = effectiveFiles(dirs, kind, name);
  if (!files.size) return undefined;
  const target = join(dirs.globalDir, twinRoot(kind, name));
  const backupName = kind === 'skill' ? `skills-${name}` : `${kind}s-${name}.md`;
  const backup = existsSync(target) ? backupEntry(target, backupDir, backupName) : undefined;
  removeEntry(target);
  for (const [rel, source] of files) {
    const path = rel ? join(target, rel) : target;
    mkdirSync(dirname(path), { recursive: true });
    writeTextFile(path, readText(source));
  }
  return backup;
}

/**
 * «Из глобального»: элемент `~/.claude` становится копией «моё» — поверх
 * встроенного или новым элементом набора, если встроенного нет. Прежняя копия
 * «моё» не теряется: она уходит в архив набора.
 */
export function importFromGlobal(
  dirs: TwinDirs,
  archiveDir: string,
  kind: KitTwinKind,
  name: string,
): boolean {
  const source = join(dirs.globalDir, twinRoot(kind, name));
  if (!existsSync(join(dirs.globalDir, twinMain(kind, name)))) return false;
  const target = join(dirs.mineDir, twinRoot(kind, name));
  if (existsSync(target)) {
    const archived = join(archiveDir, `${Date.now()}`, twinRoot(kind, name));
    mkdirSync(dirname(archived), { recursive: true });
    renameSync(target, archived);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyRecursive(source, target);
  return true;
}
