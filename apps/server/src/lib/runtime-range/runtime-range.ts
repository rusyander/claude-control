/**
 * Версии рантаймов и диапазоны из файлов проекта: `.nvmrc`, `engines.node`,
 * `requires-python`, `go.mod`. Своя маленькая реализация, а не `semver`: пакета
 * в зависимостях сервера нет, а нужен ровно один вопрос — «подходит ли эта
 * версия тому, что написано в проекте». Незнакомая запись (`lts/*`, `latest`,
 * `system`) — «не задано»: угадывать за проект нельзя, а ошибочное «не подходит»
 * увело бы подготовку копии на другую версию без причины.
 */

export type Triple = [number, number, number];

/** Версия из текста: `v22.22.2`, `22.22`, `3.12.1rc1` → числа; нет цифр — `undefined`. */
export function parseVersion(text: string | undefined): Triple | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text ?? '');
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function compareVersions(a: Triple, b: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] as number) - (b[index] as number);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Короткая запись: `22`, `22.x`, `v22.22` — не точная версия, а целая линия. */
function partsOf(text: string): { numbers: number[]; wildcard: boolean } {
  const cleaned = text.trim().replace(/^[v=]+/i, '');
  const raw = cleaned.split('.');
  const numbers: number[] = [];
  let wildcard = false;
  for (const part of raw) {
    if (/^(x|\*)$/i.test(part) || part === '') {
      wildcard = true;
      break;
    }
    const value = Number.parseInt(part, 10);
    if (Number.isNaN(value)) break;
    numbers.push(value);
  }
  return { numbers, wildcard };
}

type Comparator = (version: Triple) => boolean;

/** Одно условие диапазона; `undefined` — запись не понята. */
function comparatorOf(token: string): Comparator | undefined {
  const match = /^(>=|<=|>|<|=|\^|~=|~)?\s*(.+)$/.exec(token.trim());
  if (!match) return undefined;
  const op = match[1] ?? '';
  const { numbers, wildcard } = partsOf(match[2] as string);
  if (numbers.length === 0) return op === '' && wildcard ? () => true : undefined;
  const base: Triple = [numbers[0] as number, numbers[1] ?? 0, numbers[2] ?? 0];
  const partial = numbers.length < 3 || wildcard;
  switch (op) {
    case '>=':
      return (v) => compareVersions(v, base) >= 0;
    case '>':
      // «>22» — всё после линии 22; «>22.1.0» — всё строго больше.
      return partial
        ? (v) => compareVersions(v, bump(numbers)) >= 0
        : (v) => compareVersions(v, base) > 0;
    case '<=':
      return partial
        ? (v) => compareVersions(v, bump(numbers)) < 0
        : (v) => compareVersions(v, base) <= 0;
    case '<':
      return (v) => compareVersions(v, base) < 0;
    case '^': {
      // Каретка держит старшую ненулевую часть: ^22.1.0 → <23, ^0.3.1 → <0.4.
      const major = numbers[0] as number;
      const upper: Triple =
        major > 0
          ? [major + 1, 0, 0]
          : (numbers[1] ?? 0) > 0 || numbers.length < 2
            ? [0, (numbers[1] ?? 0) + 1, 0]
            : [0, 0, (numbers[2] ?? 0) + 1];
      return (v) => compareVersions(v, base) >= 0 && compareVersions(v, upper) < 0;
    }
    case '~':
    case '~=': {
      // Тильда: до следующей младшей — ~22.1 → <22.2; ~22 → <23.
      const upper: Triple =
        numbers.length >= 2 ? [numbers[0] as number, (numbers[1] as number) + 1, 0] : bump(numbers);
      return (v) => compareVersions(v, base) >= 0 && compareVersions(v, upper) < 0;
    }
    default:
      // Точная версия или целая линия: «22» и «22.x» — любая 22.*, «22.22.2» — только она.
      if (!partial) return (v) => compareVersions(v, base) === 0;
      return (v) => numbers.every((value, index) => v[index] === value);
  }
}

/** Первая версия после линии: [22] → 23.0.0, [3, 12] → 3.13.0. */
function bump(numbers: readonly number[]): Triple {
  if (numbers.length >= 2) return [numbers[0] as number, (numbers[1] as number) + 1, 0];
  return [(numbers[0] as number) + 1, 0, 0];
}

/**
 * Версия подходит диапазону. `undefined` — диапазон записан так, что понять его
 * нельзя: вызывающий читает это как «требования нет».
 */
export function satisfiesRange(version: Triple, range: string): boolean | undefined {
  const alternatives = range
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);
  if (alternatives.length === 0) return undefined;
  let understood = false;
  for (const alternative of alternatives) {
    // Условия внутри альтернативы — через пробел, запятую или `&&` («>=3.9,<3.13»).
    const tokens = alternative
      .replace(/&&/g, ' ')
      .replace(/(>=|<=|>|<|=|\^|~=|~)\s+(?=\d|v)/g, '$1')
      .split(/[\s,]+/)
      .filter(Boolean);
    const comparators = tokens.map(comparatorOf);
    if (comparators.some((item) => item === undefined)) continue;
    understood = true;
    if ((comparators as Comparator[]).every((item) => item(version))) return true;
  }
  return understood ? false : undefined;
}

/** Записи «подойдёт любая»: алиасы версий менеджеров, не диапазон. */
const ANY = /^(lts(\/.*)?|node|stable|latest|current|system|default|\*|x)$/i;

/**
 * Что проект просит, как диапазон. Пусто и алиасы — `undefined` (требования нет).
 * Файл версий (`.nvmrc`, `.python-version`) хранит точную версию или линию —
 * то же самое, что диапазон.
 */
export function wantedRange(text: string | undefined): string | undefined {
  const value = text?.trim();
  if (!value || ANY.test(value)) return undefined;
  return parseVersion(value) ? value : undefined;
}

/** Из списка версий — самая новая из подходящих диапазону. */
export function bestMatching<T extends { version: Triple }>(
  candidates: readonly T[],
  range: string,
): T | undefined {
  return candidates
    .filter((item) => satisfiesRange(item.version, range) === true)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

export function formatVersion(version: Triple): string {
  return version.join('.');
}
