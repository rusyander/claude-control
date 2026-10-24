/**
 * Шаблон одного сегмента пути так, как его раскрывает bash: `*`, `?`, `[…]`
 * (с `!`/`^`). Имя с точкой в начале находит только шаблон, который сам
 * начинается с точки, или любой — после `shopt -s dotglob`.
 *
 * Раньше цель удаления сверялась с `.git` и локальным слоем буквально, а
 * `globToRegExp` зеркала не знает `[…]`: `rm -rf .g*`, `.gi?`, `.cl*` сносили
 * историю копии и `.claude` без карточки (ревью 23.10, F-05).
 */

export const GLOB = /[*?[]/;

const WIN = process.platform === 'win32';
const SPECIAL = /[.+^${}()|\\/]/g;

/** Класс `[…]` начиная с `start` (на `[`): источник регулярки и индекс `]`; `undefined` — не класс. */
function bracket(pattern: string, start: number): { source: string; end: number } | undefined {
  let i = start + 1;
  const negate = pattern[i] === '!' || pattern[i] === '^';
  if (negate) i += 1;
  // `]` сразу после `[` или `[!` — буква класса, а не его конец.
  const end = pattern.indexOf(']', pattern[i] === ']' ? i + 1 : i);
  if (end < 0) return undefined;
  const body = pattern.slice(i, end);
  // `[[:alpha:]]` и прочие классы POSIX — любой символ: шире, не уже настоящего.
  if (body.includes('[:')) return { source: '[^/]', end: pattern.indexOf(']', end + 1) };
  const escaped = body.replace(/[\\\]^]/g, '\\$&');
  return { source: `[${negate ? '^' : ''}${escaped}]`, end };
}

export function segmentGlob(pattern: string, dotglob: boolean): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else if (ch === '[') {
      const found = bracket(pattern, i);
      if (!found || found.end < 0) {
        source += '\\[';
        continue;
      }
      source += found.source;
      i = found.end;
    } else source += ch.replace(SPECIAL, '\\$&');
  }
  const hidden = pattern.startsWith('.') || dotglob ? '' : '(?!\\.)';
  return new RegExp(`^${hidden}${source}$`, WIN ? 'i' : '');
}

/**
 * Сегмент цели (может быть шаблоном) совпадает с именем. Перевёрнутый диапазон
 * (`[core-003]`: `e-0`) bash не совпадает ни с чем — и здесь не совпадает, а не
 * роняет разбор: такое слово бывает и не путём (JSON в `--json '{…}'`).
 */
export function segmentMatches(target: string, name: string, dotglob: boolean): boolean {
  if (!GLOB.test(target)) return target === name;
  try {
    return segmentGlob(target, dotglob).test(name);
  } catch {
    return false;
  }
}
