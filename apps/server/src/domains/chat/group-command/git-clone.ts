import { isAbsolute } from 'node:path';
import { resolveFrom } from './paths.ts';
import type { Word } from './shell-parse.ts';
import type { Walk } from './walk.ts';
import { writeKind } from './writes.ts';

/** Ключи `git clone` без значения, что не уводят каталог git и не трогают чужое. */
const PLAIN = new Set([
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--progress',
  '-n',
  '--no-checkout',
  '-s',
  '--shared',
  '-l',
  '--local',
  '--no-local',
  '--no-hardlinks',
  '--single-branch',
  '--no-single-branch',
  '--no-tags',
  '--sparse',
  '--dissociate',
]);
/** Ключи `git clone` со значением отдельным словом или через `=`. */
const VALUED = new Set([
  '-b',
  '--branch',
  '-o',
  '--origin',
  '--depth',
  '--filter',
  '--revision',
  '-j',
  '--jobs',
  '--shallow-since',
  '--shallow-exclude',
]);

/**
 * Каталог, который заведёт `git clone <откуда> <куда>`, — только при разборе
 * без догадок: оба операнда известны, ключи из списков выше. Ключ вне списков
 * (`--separate-git-dir`, `--template`, `-c`, `--bare`, сокращения) — каталога
 * нет: git мог положить своё не туда.
 */
function cloneTarget(args: Word[]): Word | undefined {
  const operands: Word[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (arg.dynamic && !ended && arg.text.startsWith('-')) return undefined;
    if (ended || !arg.text.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    if (arg.text === '--') ended = true;
    else if (PLAIN.has(arg.text)) continue;
    else if (VALUED.has(arg.text)) i += 1;
    else if (!VALUED.has(arg.text.split('=')[0] as string) || !arg.text.includes('=')) {
      return undefined;
    }
  }
  return operands.length === 2 ? operands[1] : undefined;
}

/**
 * `git clone … <каталог>` во временное или в свою рабочую папку сессии: каталог
 * становится пробным репозиторием дальше по той же цепочке `&&`
 * (`ShellState.noteClone`, решение 23.10). Каталог вне этих мест — нет.
 */
export function noteCloneTarget(args: Word[], walk: Walk, cwd: string | undefined): void {
  const target = cloneTarget(args);
  if (!target) return;
  const word = walk.expand(target);
  if (word.dynamic) return;
  const base = cwd ?? (isAbsolute(word.text) || /^[a-zA-Z]:/.test(word.text) ? '/' : undefined);
  if (!base) return;
  const path = resolveFrom(base, word.text);
  if (writeKind(word, walk) !== 'temp' && !walk.inOwnScratchpad(path)) return;
  walk.noteClone(path);
}
