/**
 * Маска пути в стиле `.gitignore` для списков политики (06: `grantRequired.globs`, классы путей
 * человека, свои пути единицы; core-s2 F-06). Путь — относительный, через `/`. Маска без `/`
 * (кроме хвостового) — имя на любой глубине (`*.sql` = `**\/*.sql`, `.env` — любой `.env`);
 * ведущий `/` привязывает к корню; `**` — любое число каталогов; `*`, `?`, `[…]` (`[!…]` —
 * отрицание) — внутри одного имени. Маска покрывает и всё под собой (`src/api` = `src/api/**`).
 *
 * `rooted` — список от корня копии (свои пути единицы): маска без `/` не уходит вглубь, `src`
 * значит `<копия>/src`, а не чужой `pkg/src`.
 */

export type GlobMode = 'gitignore' | 'rooted';

const cache = new Map<string, RegExp>();

/** Класс `[…]` → класс RegExp без `/`; незакрытая `[` — буква. */
function charClass(glob: string, from: number): { source: string; end: number } | null {
  let i = from + 1;
  let negate = false;
  if (glob[i] === '!' || glob[i] === '^') {
    negate = true;
    i += 1;
  }
  let body = '';
  if (glob[i] === ']') {
    body += '\\]';
    i += 1;
  }
  for (; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === ']') return { source: `[${negate ? '^/' : ''}${body}]`, end: i };
    if (ch === '/') return null;
    body += ch === '\\' || ch === '^' || ch === '[' ? `\\${ch}` : ch;
  }
  return null;
}

function compile(glob: string, foldCase: boolean, mode: GlobMode): RegExp {
  const key = `${foldCase ? 'i' : 's'}:${mode}:${glob}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let clean = toSlashes(glob).replace(/\/+$/, '');
  const anchored = clean.startsWith('/');
  clean = clean.replace(/^\/+/, '');
  // Без `/` внутри — имя на любой глубине (как в .gitignore), кроме списков от корня.
  const anywhere = !anchored && mode === 'gitignore' && !clean.includes('/');
  let body = '';
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i] ?? '';
    if (ch === '*' && clean[i + 1] === '*') {
      // `**/` — ноль и больше каталогов; `**` в конце — что угодно.
      if (clean[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (ch === '*') body += '[^/]*';
    else if (ch === '?') body += '[^/]';
    else if (ch === '[' && charClass(clean, i)) {
      const cls = charClass(clean, i) as { source: string; end: number };
      body += cls.source;
      i = cls.end;
    } else body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${body}(?:/.*)?$`, foldCase ? 'i' : '');
  cache.set(key, re);
  return re;
}

export function toSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function matchesGlob(
  path: string,
  glob: string,
  foldCase = false,
  mode: GlobMode = 'gitignore',
): boolean {
  return compile(glob, foldCase, mode).test(toSlashes(path));
}

export function matchesAny(
  path: string,
  globs: readonly string[],
  foldCase = false,
  mode: GlobMode = 'gitignore',
): boolean {
  return globs.some((g) => matchesGlob(path, g, foldCase, mode));
}
