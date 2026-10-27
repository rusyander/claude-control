import { resolveFrom } from './paths.ts';
import type { Word } from './shell-parse.ts';
import { writeKind } from './writes.ts';
import { isAbsolute, type Walk } from './walk.ts';

/**
 * Файл, который пишет сам git по ключу команды (D-9, 25.10): `git archive -o
 * ../x.tar`, `git diff --output=/c/Users/x.patch`, `git format-patch -o ../p`,
 * `git bundle create ../x.bundle`. Подкоманды судились чтением и шли сами — запись
 * вне копии и временного проходила мимо суда путей, которым судится `tar -x -C`.
 * Вне копии и временного (или куда — не узнать) — человеку.
 */

/** `--output` и его начала, которые git принимает за него (`--outp=`); `--out` — тоже. */
const OUTPUT_LONG = /^--out(p(u(t)?)?)?(=|$)/;
/** Подкоманды с выводом в файл по `--output`: diff и всё, что берёт его ключи. */
const DIFF_OUTPUT = new Set([
  'diff',
  'log',
  'show',
  'diff-tree',
  'diff-index',
  'diff-files',
  'whatchanged',
  'range-diff',
  'format-patch',
]);

/** Значение ключа: склеенное (`--output=f`, `-of`) или следующее слово. */
function valueOf(args: readonly Word[], at: number, glued: string): Word | null {
  const word = args[at] as Word;
  if (glued) return { ...word, text: glued };
  return args[at + 1] ?? null;
}

/** Пути, куда пишет git по ключам этой подкоманды; `null` — пути нет (ключ без значения). */
function outputsOf(sub: string, args: readonly Word[]): (Word | null)[] {
  const out: (Word | null)[] = [];
  const shortO = sub === 'archive' || sub === 'format-patch';
  if (!shortO && !DIFF_OUTPUT.has(sub) && sub !== 'bundle') return out;
  for (let at = 0; at < args.length; at += 1) {
    const text = (args[at] as Word).text;
    if (text === '--') break;
    if (OUTPUT_LONG.test(text) || (sub === 'format-patch' && /^--output-d/.test(text))) {
      const eq = text.indexOf('=');
      out.push(valueOf(args, at, eq < 0 ? '' : text.slice(eq + 1)));
      if (eq < 0) at += 1;
    } else if (shortO && /^-o/.test(text)) {
      out.push(valueOf(args, at, text.slice(2)));
      if (text === '-o') at += 1;
    }
  }
  if (sub === 'bundle' && args[0]?.text === 'create') {
    out.push(args.slice(1).find((word) => !word.text.startsWith('-')) ?? null);
  }
  return out;
}

/** Запись git в файл по ключу уходит из копии и временного, или куда — не узнать. */
export function gitWritesOutside(
  sub: string,
  args: readonly Word[],
  walk: Walk,
  cwd: string | undefined,
): boolean {
  return outputsOf(sub, args).some((word) => {
    if (word === null || word.dynamic) return true;
    // `git -C <каталог>` — относительный путь от него, а не от оболочки.
    const absolute = isAbsolute(word.text) || /^~/.test(word.text);
    if (absolute) return outside(word, walk);
    return cwd === undefined || outside({ ...word, text: resolveFrom(cwd, word.text) }, walk);
  });
}

function outside(word: Word, walk: Walk): boolean {
  const kind = writeKind(word, walk);
  return kind !== 'inside' && kind !== 'temp';
}
