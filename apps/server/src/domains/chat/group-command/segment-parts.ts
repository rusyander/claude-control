import { killVerdict } from './kill.ts';
import type { Redirect, Word } from './shell-parse.ts';
import { targetKind } from './targets.ts';
import { OTHER, ROUTINE, UNNAMED_KILL, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * Части суда над звеном, которым не нужен обход вложенных сценариев: имя
 * команды, перенаправления, `tee`, погашение. Вынесено из `group-command.ts`
 * по размеру.
 */

/** Потоки и «никуда»: `>/dev/null`, `2>NUL`. */
const QUIET_TARGET = /^(\/dev\/(null|stdout|stderr)|nul)$/i;

/** Запись в файл: временный путь — свой, как и для удаления, плюс `/tmp/…` и `$TMPDIR/…`. */
function writesTemp(target: Word, walk: Walk): boolean {
  if (!target.dynamic && QUIET_TARGET.test(target.text)) return true;
  return targetKind(target, walk, { ...walk.place(), write: true }) === 'temp';
}

/**
 * Перенаправление ничего не портит: чтение файла, слияние потоков, вывод в
 * никуда или во временный файл. Запись в любой другой файл решают правила чата.
 */
export function harmlessRedirect(redirect: Redirect, walk: Walk): boolean {
  const { op } = redirect;
  const target = walk.expand(redirect.target);
  if (op === '<') return true;
  if ((op === '>&' || op === '<&') && !target.dynamic && /^(\d+|-)$/.test(target.text)) {
    return true;
  }
  if (op === '<&') return false;
  return writesTemp(redirect.target, walk);
}

/** `tee файл…`: копия вывода — во временное или в никуда; прочий файл — правила чата. */
export function teeVerdict(words: Word[], walk: Walk): SegmentVerdict {
  const files = words.slice(1).filter((word) => !word.text.startsWith('-'));
  return files.every((file) => writesTemp(file, walk)) ? ROUTINE : OTHER;
}

/**
 * Звено погашения процесса (N3): свои дети оболочки (`$!`, `%1`, проба
 * `kill -0`) — рутина; номер или порт — рутина с целями, которые маршрут прав
 * сверит с деревом процессов группы; цель, которую числом не назвать (`/IM`,
 * `pkill -f`, `$(cat pidfile)`), — рутина с меткой `unnamed`: маршрут прав
 * отказывает агенту сам, с тем, как назвать своё (D-1, 24.10: человеку не идёт).
 */
export function killSegment(words: Word[], walk: Walk): SegmentVerdict | undefined {
  const verdict = killVerdict(words, walk.childMark, (word) => walk.portsOf(word));
  if (!verdict) return undefined;
  if (verdict.kind === 'own') return ROUTINE;
  if (verdict.kind === 'unknown') return UNNAMED_KILL;
  return { kind: 'routine', kills: verdict.targets };
}

/**
 * Имя команды: без `\`, пути, `.exe` и регистра — `\rm`, `/bin/rm`, `RM.EXE`
 * исполнят тот же `rm` (ревью 23.10, F-15). `undefined` — имя не прочесть.
 */
export function commandName(word: Word): string | undefined {
  let text = word.text;
  if (word.dynamic) {
    text = text.replace(/\\(.)/gs, '$1');
    if (/[$`%{}*?[]/.test(text) || text.startsWith('~')) {
      // `"$NVM_HOME/v22/node.exe" -v`: каталог неизвестен, но программа названа
      // буквально — исполнится она. Сценарий под неизвестным путём — нет.
      const base = /[\\/]([^\\/$`%{}*?[~]+)$/.exec(text)?.[1];
      if (!base || /^\.\.?$/.test(base) || SCRIPT_PATH.test(base)) return undefined;
      text = base;
    }
  }
  return (text.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
}

/** Сценарий из файла под неизвестным путём (`"$ROOT"/tools/x.mjs`): что он сделает, не прочесть. */
export const SCRIPT_PATH = /\.(sh|bash|zsh|mjs|cjs|js|ts|mts|cts|py|rb|pl|php|ps1)$/i;

/** Встроенные оболочки: имя исполнит она сама, а не программа по `PATH`. */
export const SHELL_BUILTINS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  'pwd',
  'test',
  '[',
  '[[',
  ':',
  'eval',
  'trap',
  'alias',
  'kill',
]);

/** Что печатает звено в трубу, если это известно: `echo "git push origin main" | bash`. */
/**
 * Печать звена известна целиком: `echo`/`printf` буквальных слов, `cat` одного
 * heredoc. Остальное печатает то, чего в тексте команды нет (`cat list.txt`,
 * `curl …`), — оболочка, которой это скормлено (`cat list.txt | sh`),
 * исполнит непрочитанное (ревью 23.10, зона A).
 */
export function knownOutput(words: Word[], inputs: readonly string[]): boolean {
  const name = words[0]?.text;
  if (name === 'echo' || name === 'printf') return words.every((word) => !word.dynamic);
  return name === 'cat' && words.length === 1 && inputs.length > 0;
}

export function printed(words: Word[]): string[] {
  const name = words[0]?.text;
  if (name !== 'echo' && name !== 'printf') return [];
  return [
    words
      .slice(1)
      .map((word) => word.text)
      .join(' '),
  ];
}
