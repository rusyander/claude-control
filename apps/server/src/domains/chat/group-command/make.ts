import type { Word } from './shell-parse.ts';
import { DANGER, OTHER, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * `make` (раунд 10, 24.10): рецепты Makefile — чужой код каталога, где идёт
 * сборка. В своей копии это работа группы (правила чата, `OTHER`); `make -C
 * /c/Users clean` или `cd /c/Users && make clean` исполняет рецепты чужого
 * дерева — там `clean` удаляет вне копии. Каталог судится, как у прочих
 * обёрток с `-C` (`env -C`, `git -C`): `-C каталог`, `-Cкаталог`,
 * `--directory=каталог`, `--directory каталог`, несколько `-C` — каждый от
 * предыдущего. Каталог `-C` не узнать (`-C "$D"`) — человеку. Без `-C` и с
 * неизвестным каталогом звена — как раньше, правила чата.
 */

const MAKES = new Set(['make', 'gmake', 'bmake', 'mingw32-make']);

export function isMake(name: string): boolean {
  return MAKES.has(name);
}

const UNKNOWN: Word = { text: '', dynamic: true };

/**
 * Короткие ключи GNU make со значением: обязательным (`-f file`, `-fFILE`) и
 * необязательным, только слитным (`-j4`). Остальные буквы — без значения, и
 * getopt читает их пачкой: `-sC /c/Users` и `-kC/c/Users` — это `-C`
 * (повторная проверка 24.10: пачка и `--dir=` проходили сами).
 */
const SHORT_REQUIRED = new Set(['C', 'f', 'I', 'o', 'W', 'E']);
const SHORT_OPTIONAL = new Set(['j', 'l', 'O']);

/** `--di`…`--directory`: getopt принимает любое однозначное начало, `--d` — нет (`--debug`, `--dry-run`). */
function directoryKey(name: string): boolean {
  return name.length >= 2 && 'directory'.startsWith(name);
}

/** Каталог из пачки коротких ключей; `skip` — значение ушло следующим словом. */
function clusterDir(arg: Word, next: Word | undefined): { dir?: Word; skip: boolean } {
  const text = arg.text;
  for (let at = 1; at < text.length; at += 1) {
    const flag = text[at] as string;
    if (SHORT_OPTIONAL.has(flag)) return { skip: false };
    if (!SHORT_REQUIRED.has(flag)) continue;
    const rest = text.slice(at + 1);
    const value = rest ? { ...arg, text: rest } : (next ?? UNKNOWN);
    return { ...(flag === 'C' ? { dir: value } : {}), skip: rest === '' };
  }
  return { skip: false };
}

/** Каталоги `-C` по порядку; без значения — неизвестный. */
function makeDirs(args: Word[]): Word[] {
  const dirs: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const text = arg.text;
    if (text === '--') break;
    const long = /^--([^=]+)(=?)/.exec(text);
    if (long) {
      if (!directoryKey(long[1] as string)) continue;
      if (long[2]) dirs.push({ ...arg, text: text.slice(text.indexOf('=') + 1) });
      else {
        dirs.push(args[i + 1] ?? UNKNOWN);
        i += 1;
      }
    } else if (/^-[^-]/.test(text)) {
      const { dir, skip } = clusterDir(arg, args[i + 1]);
      if (dir) dirs.push(dir);
      if (skip) i += 1;
    }
  }
  return dirs;
}

function inDirs<T>(dirs: Word[], walk: Walk, run: () => T, at = 0): T {
  const dir = dirs[at];
  return dir ? walk.inDir(dir, () => inDirs(dirs, walk, run, at + 1)) : run();
}

export function makeVerdict(words: Word[], walk: Walk): SegmentVerdict {
  const dirs = makeDirs(words.slice(1));
  return inDirs(dirs, walk, () => {
    const cwd = walk.place().cwd;
    if (cwd === undefined) return dirs.length > 0 ? DANGER : OTHER;
    return walk.inCopy(cwd) || walk.inOwnScratchpad(cwd) ? OTHER : DANGER;
  });
}
