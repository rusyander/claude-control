import path from 'node:path';
import { currentOs } from '../../platform/os-kind.ts';
import { isInside, pathKey } from '../../platform/paths.ts';
import type { ExecAnalysis, ExecWord } from './exec-argv/exec-argv.types.ts';
import { hole, isOpaque, isProcessSubstitution, wordPattern } from './exec-argv/marks.ts';
import { canonicalTarget } from './target-path.ts';

/**
 * Дом ядра и токены через оболочку (core-s2 F-05): `cat ~/.agentdeck/token`, `rg secret ~`,
 * `cd ~ && cat .agentdeck/token`, маска `~/.agentdeck*` — судья сверяет каждое слово команд и
 * цель перенаправления с путями платформы. Отказ — слово внутри пути платформы или его предок
 * (поиск по предку дойдёт до токена). Предок не считается, где слово — только текст: аргумент
 * `echo`/`printf`/`tr`…, корень `/` после опции или в присваивании (`cut -d /`, `IFS=/`).
 * Слово с дырой (маска, переменная) — отказ, если срез до `/` с буквальным последним сегментом
 * может оказаться путём платформы; `cd` в невидимый каталог — сверка хвоста относительного пути.
 */

/** Команды, чьи аргументы — текст или имя каталога без обхода содержимого: предок не считается. */
const TEXT_HEADS = new Set([
  'echo',
  'printf',
  'print',
  'tr',
  'cut',
  'test',
  '[',
  '[[',
  'cd',
  'pushd',
  'popd',
  'chdir',
  'set-location',
  'sl',
  'ls',
  'dir',
  'basename',
  'dirname',
  'mkdir',
  'realpath',
  'readlink',
  'which',
  'write-host',
  'write-output',
]);

/** Корень копии и пути платформы — уже сложенные `foldedPaths` (H7): та же форма, что у слов. */
export interface ExecPathContext {
  copyRoot: string;
  platformPaths: readonly string[];
  home: string;
}

type Os = ReturnType<typeof currentOs>;

// eslint-disable-next-line no-control-regex -- метки дыр и есть управляющие знаки \0 и \1
const HOLES = /\u0000[^\u0001]*\u0001/g;

/** Слово → путь: значение `--x=`, без `@`, `file://`, `~`, путей MSYS (`/c/…`). */
function asPath(text: string, home: string, os: Os): string {
  let t = text;
  const option = /^-{1,2}[^=\s]*=(.*)$/s.exec(t);
  if (option) t = option[1] as string;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s.exec(t);
  if (assignment) t = assignment[1] as string;
  t = t.replace(/^@/, '').replace(/^file:\/\//i, '');
  if (/^~(?=[\\/]|$)/.test(t)) t = home + t.slice(1);
  if (os === 'win32') {
    t = t.replace(/^\/([A-Za-z]:)/, '$1');
    // `/c/Users/…` Git Bash, `/cygdrive/c/…`, `/mnt/c/…`; голое `/c` — ключ `cmd /c`, не диск.
    const msys = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?=\/)/.exec(t);
    if (msys) t = `${msys[1]}:${t.slice(msys[0].length)}`;
  }
  return t;
}

/**
 * Доля или устройство Windows: `\\host\share…`, `\\?\…`, `\\.\…` (и через `/`). Голое `//`
 * (`grep "// TODO"`) и `\\bfoo` (регулярное выражение) — не пути: имени доли в них нет.
 */
const SHARE_SHAPE = /^[\\/]{2}(?:[?.][\\/]|[^\\/\s]+[\\/][^\\/\s]+)/;

/**
 * Путь слова в той форме, что и цель read/edit (H7): `\\localhost\C$\…`, `\\?\C:\…`, поток,
 * хвостовая точка → `C:\…`. Несводимое без формы доли остаётся как написано — это не путь.
 */
function foldWord(p: string, os: Os): string {
  if (os !== 'win32') return p;
  const canon = canonicalTarget(p, os);
  return 'path' in canon ? canon.path : p;
}

/** Слово — доля или устройство, которое сложить в путь диска нельзя: с путём платформы не сравнить. */
function unfoldableShare(p: string, os: Os): boolean {
  if (os !== 'win32' || !SHARE_SHAPE.test(p)) return false;
  return isOpaque(p) || 'refuse' in canonicalTarget(p, os);
}

function isRoot(p: string, os: Os): boolean {
  return os === 'win32' ? /^([A-Za-z]:)?[\\/]+$/.test(p) || /^[A-Za-z]:$/.test(p) : /^\/+$/.test(p);
}

/** Сегменты пути со сложенным регистром там, где ОС его не различает. */
function segments(p: string, os: Os): string[] {
  const folded = os === 'linux' ? p : p.toLowerCase();
  return folded.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
}

function slashKey(p: string, os: Os): string {
  const key = pathKey(p, os).replace(/\\/g, '/');
  return os === 'linux' ? key : key.toLowerCase();
}

/** Срезы по `/`, чей последний сегмент содержит буквальный знак: каждый может быть путём платформы. */
function opaqueHit(candidate: string, keys: readonly string[], os: Os): boolean {
  const parts = candidate.replace(/\\/g, '/').split('/');
  for (let k = 1; k <= parts.length; k++) {
    const last = parts[k - 1] as string;
    if (last.replace(HOLES, '') === '') continue;
    const cut = parts.slice(0, k).join('/');
    const re = wordPattern(os === 'linux' ? cut : cut.toLowerCase());
    if (keys.some((key) => re.test(key))) return true;
  }
  // Буквальный каталог перед дырой — предок пути платформы: маска дойдёт до него.
  const literal = candidate.replace(/\\/g, '/').split('\u0000')[0] as string;
  const dir = literal.slice(0, literal.lastIndexOf('/') + 1);
  if (dir === '' || !path.isAbsolute(dir)) return false;
  const folded = os === 'linux' ? dir : dir.toLowerCase();
  return keys.some((key) => `${key}/`.startsWith(folded));
}

function wordHit(
  word: ExecWord,
  bases: readonly string[],
  analysis: ExecAnalysis,
  ctx: ExecPathContext,
  os: Os,
  keys: readonly string[],
): boolean {
  if (isProcessSubstitution(word.text)) return false;
  const p = asPath(word.text, ctx.home, os);
  if (p === '' || (word.text.startsWith('-') && !word.text.includes('='))) return false;
  const textOnly =
    TEXT_HEADS.has(word.head) ||
    (isRoot(p, os) && (word.prev.startsWith('-') || /^[A-Za-z_]\w*=/.test(word.text)));
  // Чужая доля может оказаться этим же диском по имени в сети, доля с дырой — чем угодно:
  // несводимое — отказ (06 §Session permissions), даже у текстовой команды.
  if (unfoldableShare(p, os)) return true;
  if (isOpaque(p)) {
    if (textOnly) return false;
    const absolute = path.isAbsolute(p.replace(HOLES, 'x')) || p.startsWith('\u0000');
    const candidates = absolute ? [p] : bases.map((b) => `${b}/${p}`);
    if (!absolute && analysis.cwdUnknown) candidates.push(`${hole()}/${p}`);
    return candidates.some((c) => opaqueHit(c, keys, os));
  }
  const targets = (path.isAbsolute(p) ? [p] : bases.map((b) => path.resolve(b, p))).map((t) =>
    foldWord(t, os),
  );
  for (const target of targets) {
    for (const platform of ctx.platformPaths) {
      if (isInside(platform, target, os)) return true;
      if (!textOnly && isInside(target, platform, os)) return true;
    }
  }
  if (!path.isAbsolute(p) && analysis.cwdUnknown) {
    // `cd $X && cat .agentdeck/token`: начало пути совпадает с хвостом пути платформы.
    const word = segments(p, os);
    if (word[0] === '..') return false;
    for (const platform of ctx.platformPaths) {
      const tail = segments(platform, os);
      for (let k = 1; k <= Math.min(word.length, tail.length); k++) {
        if (tail.slice(-k).join('/') === word.slice(0, k).join('/')) return true;
      }
    }
  }
  return false;
}

/** Слово команды, которое называет путь платформы (или его предка); `null` — таких нет. */
export function execPlatformPath(analysis: ExecAnalysis, ctx: ExecPathContext): string | null {
  if (ctx.platformPaths.length === 0) return null;
  const os = currentOs();
  const keys = ctx.platformPaths.map((p) => slashKey(p, os));
  const bases = [ctx.copyRoot];
  for (const cwd of analysis.cwds) {
    const p = asPath(cwd, ctx.home, os);
    bases.push(foldWord(path.isAbsolute(p) ? p : path.resolve(ctx.copyRoot, p), os));
  }
  for (const word of analysis.words) {
    if (wordHit(word, bases, analysis, ctx, os, keys)) return word.text;
  }
  return null;
}
