import type { Word } from './shell-parse.ts';

/**
 * Основные и защищённые ветки: пуш в них — человеку при любых строках. Какие
 * ветки защищены на форже, панель не знает — берём общепринятые имена и ветку
 * по умолчанию у `origin`.
 */
const PROTECTED =
  /^(main|master|develop|development|dev|trunk|stable|production|prod|staging|release|releases?[/-].+)$/i;

export function isProtectedBranch(name: string, base?: string): boolean {
  return PROTECTED.test(name) || (Boolean(base) && name === base);
}

/** Имя ветки — слово, а не флаг и не подстановка. */
const named = (value: string | undefined): string | undefined =>
  value && value !== '\0' && !value.startsWith('-') ? value : undefined;

/** Короткие флаги `checkout`/`switch` без значения, после которых ветка ещё известна. */
const PLAIN_SHORT = 'fqmpl';

/**
 * Голова точно отсоединена: `--detach`, `switch -d`, коммит, `HEAD~1`,
 * `origin/x` без `-t`. Ветки тогда нет никакой — слияние двигает только HEAD.
 */
export const DETACHED = Symbol('detached');

/**
 * Сменить ветку в этой же команде: `checkout -b x`, `switch x`, `checkout --detach`.
 * `'unchanged'` — ветка та же; `undefined` — сменили, а на какую, не узнать.
 *
 * F-19 (ревью 23.10): `checkout main --` (без путей после `--`) — смена ветки,
 * а не откат файлов; `checkout -` — прошлая ветка, какая — не известно; `-Cmain`
 * и `-fb x` — значение слитно с флагом. Раньше всё это оставляло ветку своей, и
 * `git push origin HEAD` следом уходил в main без карточки. `DETACHED` — голова
 * точно отсоединена (ветки нет никакой).
 */
export function checkedOut(args: Word[]): string | undefined | 'unchanged' | typeof DETACHED {
  const texts = args.map((arg) => (arg.dynamic ? '\0' : arg.text));
  const end = texts.indexOf('--');
  // `checkout main -- a.ts` — откат файлов, ветка та же.
  if (end >= 0 && end < texts.length - 1) return 'unchanged';
  const words = end >= 0 ? texts.slice(0, end) : texts;
  const positional: string[] = [];
  let track = false;
  for (let i = 0; i < words.length; i += 1) {
    const text = words[i] as string;
    if (text === '-') return undefined;
    const long = /^--(orphan|create|force-create)(?:=(.*))?$/.exec(text);
    if (long) return named(long[2] ?? words[i + 1]);
    if (text === '--detach') return DETACHED;
    if (text === '--track' || text.startsWith('--track=')) {
      track = true;
      continue;
    }
    if (text.startsWith('--')) continue;
    if (text.startsWith('-') && text !== '\0') {
      for (let j = 1; j < text.length; j += 1) {
        const letter = text[j] as string;
        if ('bBcC'.includes(letter)) return named(text.slice(j + 1) || words[i + 1]);
        if (letter === 'd') return DETACHED;
        if (letter === 't') track = true;
        else if (!PLAIN_SHORT.includes(letter)) return undefined;
      }
      continue;
    }
    positional.push(text);
  }
  if (positional.length === 0) return track ? undefined : 'unchanged';
  if (positional.length !== 1) return undefined;
  const name = positional[0] as string;
  // Коммит, `HEAD~1`, `@{-1}` — отсоединённая голова или неизвестная ветка.
  if (name === '\0' || /[@:]/.test(name)) return undefined;
  if (/^HEAD([~^]\d*)*$/.test(name)) return track ? undefined : DETACHED;
  if (/[~^]/.test(name)) return undefined;
  if (/^[0-9a-f]{7,40}$/i.test(name)) return track ? undefined : DETACHED;
  // `checkout -t origin/main` заводит `main`; без `-t` — отсоединённая голова.
  if (name.startsWith('origin/')) return track ? named(name.slice('origin/'.length)) : DETACHED;
  return name;
}
