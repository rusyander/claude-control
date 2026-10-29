import type { CheckEntry } from '@agentdeck/contracts/core/records';

/**
 * Разворот шаблона argv записи реестра (D§3.2): `{units}` `{base}` `{files}` `{tests}`. Элемент
 * шаблона, равный заполнителю целиком, становится списком (по аргументу на значение); внутри
 * элемента — подстановкой через запятую, кроме `{units}`: такой элемент повторяется на единицу.
 * Строки оболочки нет (P25): только argv.
 * Узкий прогон (выборка тестов) идёт по `filter.argv`, когда раннер его умеет; не умеет — вся
 * единица, и это видно из возвращённого `narrowed: false`.
 */

export interface ArgvInput {
  unit: string;
  selection: string[]; // [] = вся единица
  base: string | null;
  /** Файлы — от корня репо; `argvFor` переводит их от каталога, где раннер идёт на деле. */
  files: string[];
  /** Каталог единицы от корня репо (`registry.units[unit].paths[0]`) — для `filter.filesFrom: 'unit'`. */
  unitDir?: string;
}

type Placeholder = 'units' | 'base' | 'files' | 'tests';

function valuesOf(name: Placeholder, input: ArgvInput): string[] {
  switch (name) {
    case 'units':
      // `.` — вся копия (проверка уровня проекта, производная): аргумента единицы нет.
      return input.unit === '' || input.unit === '.' ? [] : [input.unit];
    case 'base':
      return input.base === null ? [] : [input.base];
    case 'files':
      return input.files;
    case 'tests':
      return input.selection;
  }
}

/**
 * Путь или единица целым элементом argv, начинающиеся с «-», раннер прочёл бы как флаг (B1r3-F04):
 * `./-x` — тот же путь, но не флаг. Выборка `{tests}` здесь не трогается — её стережёт `selectionArgs`.
 */
const notFlag = (name: Placeholder, value: string): string =>
  (name === 'units' || name === 'files') && value.startsWith('-') ? `./${value}` : value;

export function expandTemplate(template: readonly string[], input: ArgvInput): string[] {
  const out: string[] = [];
  for (const part of template) {
    const whole = /^\{(units|base|files|tests)\}$/.exec(part);
    if (whole) {
      const name = whole[1] as Placeholder;
      out.push(...valuesOf(name, input).map((v) => notFlag(name, v)));
      continue;
    }
    const fill = (unit: string | null): string =>
      part.replace(/\{(units|base|files|tests)\}/g, (_m, name: Placeholder) =>
        name === 'units' && unit !== null ? unit : valuesOf(name, input).join(','),
      );
    if (part.includes('{units}')) {
      // Решение зоны E: элемент с `{units}` внутри повторяется на каждую единицу
      // (`--filter={units}` → `--filter=a --filter=b`); единиц нет — элемента нет.
      for (const unit of valuesOf('units', input)) out.push(fill(unit));
      continue;
    }
    out.push(fill(null));
  }
  return out;
}

type FilterKind = NonNullable<CheckEntry['filter']>['kind'];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Полное имя «a > b > it» → регулярка полного имени раннера. vitest 4, jest и playwright склеивают
 * части пробелом, vitest 5 — « > » (проверено на 5.0.5: `-t "a b"` не выбирал ничего); разделитель
 * берёт обе формы, иначе узкий прогон на другой версии раннера пуст.
 */
const fullNamePattern = (name: string): string =>
  name
    .split(/\s+[>›]\s+/)
    .map(escapeRegExp)
    .join('(?: > | )');

const JAVA_ID = /^[\w$]+$/;

/**
 * Строка Gradle `Cls > [Nested >] method() [> [1] …]` → шаблон `--tests` `Cls[$Nested].method`
 * (A1r3-F05). Gradle сверяет класс и ИМЯ метода, не имя показа: `addsTwo()` с скобками и
 * `Outer.Nested inner()` не совпадали ни с чем, раннер падал «No tests found» — красный на пустом.
 * Имя показа с пробелами (@DisplayName) метода не называет — `null`, вся единица.
 */
function gradlePattern(name: string): string | null {
  const parts = name.split(/\s+>\s+/);
  const cls = parts[0] as string;
  if (parts.length < 2 || !/^[\w.$]+$/.test(cls)) return null;
  // Метод — первое звено со скобками (JUnit 5; дальше — вызовы параметризованного), иначе последнее
  // (JUnit 4, `testParam[0]` без индекса).
  let at = parts.findIndex((p, i) => i > 0 && /^[\w$]+\(.*\)$/.test(p));
  if (at < 0) at = parts.length - 1;
  const method = (parts[at] as string).replace(/\(.*\)$/, '').replace(/(?:\[[^\]]*\])+$/, '');
  const nested = parts.slice(1, at);
  if (!JAVA_ID.test(method) || !nested.every((n) => JAVA_ID.test(n))) return null;
  return `${[cls, ...nested].join('$')}.${method}`;
}

/**
 * Выборка тестов в аргументы фильтра раннера (`{tests}`). Имя приходит в форме разбора упавших
 * (`failing.ts`); раннер сверяет его по-своему. «a > b» дословно в `-t` vitest 4 не совпадает ни с
 * чем, «a b» — в vitest 5, и раннер выходит с 0 — ложный зелёный узкого прогона, повтора флаки и
 * красного-до (найдено зоной B). Поэтому: регулярка из экранированных частей с разделителем обеих
 * форм (`fullNamePattern`, тот же у `namePattern` прогонщика мутаций), несколько имён — одна
 * альтернатива. `null` — выборку этот раннер одной командой не
 * принимает: гонится вся единица (дольше, но честно).
 */
export function selectionArgs(kind: FilterKind, names: readonly string[]): string[] | null {
  if (names.length === 0) return [];
  // Имя с «-» в начале у cargo/gradle/vitest стало бы флагом раннера (`--config=…`, B1r3-F04):
  // такой выборки одной командой нет — вся единица.
  if (names.some((n) => n.trimStart().startsWith('-'))) return null;
  switch (kind) {
    case 'vitest':
    case 'jest':
    case 'playwright':
      return [names.map(fullNamePattern).join('|')];
    case 'go': {
      // `-run` делит шаблон по «/» на уровни: гонится тест верхнего уровня целиком с подтестами.
      const top = [...new Set(names.map((n) => n.split('/')[0] as string))];
      return [`^(?:${top.map(escapeRegExp).join('|')})$`];
    }
    case 'pytest': {
      // Имя без файла (`Cls::test[param]`) путём не годится — выражение `-k` по частям имени.
      const terms = names.map((n) => {
        const parts = n
          .replace(/\[.*\]$/, '')
          .split('::')
          .filter(Boolean);
        return `(${parts.join(' and ')})`;
      });
      return ['-k', terms.join(' or ')];
    }
    case 'dotnet':
      return [
        names.map((n) => `FullyQualifiedName~${n.replace(/[()&|=!~\\]/g, '\\$&')}`).join('|'),
      ];
    case 'maven':
      // `a.b.Cls.method` и старое `method(a.b.Cls)` → `a.b.Cls#method`; несколько — через запятую.
      // Параметры JUnit 5 (`adds(int)[1]`) Surefire не сверяет — метод без них (A1r3-F05).
      return [
        names
          .map((n) => {
            const old = /^([\w$]+)\(([\w.$]+)\)$/.exec(n);
            if (old) return `${old[2]}#${old[1]}`;
            const bare = n.replace(/(?:\[[^\]]*\])+$/, '').replace(/\([^()]*\)$/, '');
            const dot = bare.lastIndexOf('.');
            return dot > 0 ? `${bare.slice(0, dot)}#${bare.slice(dot + 1)}` : bare;
          })
          .join(','),
      ];
    case 'gradle': {
      // `--tests` берёт один шаблон: несколько имён — вся единица.
      if (names.length > 1) return null;
      const pattern = gradlePattern(names[0] as string);
      return pattern === null ? null : [pattern];
    }
    case 'cargo':
      // Фильтр cargo — одна подстрока: несколько имён одной командой не выбрать.
      return names.length > 1 ? null : [names[0] as string];
  }
}

/**
 * Путь от корня репо → путь от `cwd` записи (оба с `/`). Раннер разрешает файл от своего рабочего
 * каталога: у члена воркспейса это каталог члена, и `packages/a/src/a.test.ts` там не нашёлся бы.
 */
export function fromEntryCwd(cwd: string, file: string): string {
  const base = cwd.split('/').filter((s) => s !== '' && s !== '.');
  if (base.length === 0) return file;
  const parts = file.split('/').filter((s) => s !== '' && s !== '.');
  let same = 0;
  while (same < base.length && same < parts.length && base[same] === parts[same]) same++;
  const up = Array.from({ length: base.length - same }, () => '..');
  return [...up, ...parts.slice(same)].join('/') || '.';
}

export function argvFor(
  entry: CheckEntry,
  given: ArgvInput,
): { argv: string[]; narrowed: boolean } {
  // `{files}` — от корня репо; раннер идёт из `entry.cwd` или, за селектором члена, из каталога
  // единицы — пути переводятся туда. Каталог единицы не назван — файлов нет (шире, но не мимо:
  // путь от корня в каталоге члена не нашёл бы ничего, а выборка по имени теста остаётся).
  const runDir = entry.filter?.filesFrom === 'unit' ? given.unitDir : entry.cwd;
  const input = {
    ...given,
    files: runDir === undefined ? [] : given.files.map((f) => fromEntryCwd(runDir, f)),
  };
  const tests =
    input.selection.length > 0 && entry.filter
      ? selectionArgs(entry.filter.kind, input.selection)
      : null;
  if (entry.filter && tests) {
    // Go: единица `.` (вся копия) в узком прогоне — все пакеты `./...`; без аргумента `go test`
    // берёт только корневой пакет, и тест подпакета не находился никогда (A1r3-F06).
    const whole = input.unit === '' || input.unit === '.';
    const unit = entry.filter.kind === 'go' && whole ? './...' : input.unit;
    return {
      argv: expandTemplate(entry.filter.argv, { ...input, unit, selection: tests }),
      narrowed: true,
    };
  }
  return { argv: expandTemplate(entry.argv, { ...input, selection: [] }), narrowed: false };
}
