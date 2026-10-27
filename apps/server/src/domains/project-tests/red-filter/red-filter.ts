import type { ProjectTestFailedTest, ProjectTestRunRecord } from '@agentdeck/contracts';
import { shellQuote } from '../../../lib/shell-quote.ts';
import { BUILD_FAILURE } from '../automation/native-reports.ts';

/**
 * `run --base` гоняет на развилке только красное ветки (g0 25.10, F-03): ради одного
 * красного теста mod-llmbox развилка прогнала весь набор pytest — 2105 тестов, 2 мин 14 с.
 * Вопрос развилки — «то же ли красное было на основной», и ответ на него дают только
 * упавшие тесты ветки. Подпись (`redSignature`) — счёт упавших и первый упавший без
 * общего числа, поэтому суженный прогон с теми же падениями даёт ту же подпись, а
 * зелёный на развилке тест — «красное ветки её», как и при прогоне целиком.
 *
 * Сузить умеют раннеры с выбором теста: pytest (node id вместо каталога кейса),
 * `go test -run '^(A|B)$'`, vitest `-t`. Остальное, и любой случай, где выбор не
 * доказуем (нет списка, тест не найден файлом, команда меняет каталог или уже
 * выбирает сама), — кейс целиком, с причиной в выводе.
 */

/** Файл со списком красных тестов ветки — путь в этой переменной дочернему `run` развилки. */
export const BASE_RED_ENV = 'AGENTDECK_BASE_RED_TESTS';

/** Ключ `группа:кейс` → упавшие тесты последнего результата ветки. */
export type RedTestsByCase = Record<string, ProjectTestFailedTest[]>;

/**
 * Красные тесты из последнего результата каждого кейса в прогонах ветки (новые
 * первыми). Последний результат зелёный или без списка — кейса в ответе нет.
 */
export function branchRedTests(runs: readonly ProjectTestRunRecord[]): RedTestsByCase {
  const out: RedTestsByCase = {};
  const seen = new Set<string>();
  for (const run of runs) {
    if (run.status === 'running') continue;
    for (const result of run.results) {
      const key = `${result.groupId}:${result.caseId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (result.status === 'failed' && result.failedTests?.length) out[key] = result.failedTests;
    }
  }
  return out;
}

export interface NarrowCase {
  key: string;
  /** `automation.file` кейса — от корня проекта. */
  file: string;
  tests?: readonly ProjectTestFailedTest[];
}

export type Narrowed =
  { line: string; runner: 'pytest' | 'go' | 'vitest'; tests: number } | { reason: string };

// Слово или конец пути (`.venv/bin/pytest`, `Scripts\pytest.exe`), либо `python -m pytest`.
const PYTEST =
  /(?:^|[\s&|;(\\/"'])(?:py\.test|pytest)(?:\.exe)?["']?(?=\s|$)|\s-m\s+pytest(?=\s|$)/;
const GO_TEST = /\bgo\s+test\b/;
// `-C <каталог>` go принимает только первым флагом: `{go-modules}` строит `go test -C <модуль> …`,
// и `-run` сразу после `go test` go отвергал — «-C flag must be first flag» (g9 26.10, F7).
const GO_TEST_HEAD = /\bgo\s+test\b(?:\s+-C(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s"']+))?/g;
// `vitest` словом: `node_modules/vitest/vitest.mjs` — путь, вставка после первого «vitest» его ломала бы.
const VITEST = /(\bvitest(?:\.[cm]?js)?["']?)(?=\s|$)((?:\s+run\b)?)/g;

const clean = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Строка прогона, суженная до красных тестов ветки, или причина, почему кейсы идут
 * целиком. `exists` — есть ли файл (путь от каталога, где идёт команда, — корня проекта).
 */
export function narrowToRed(
  line: string,
  cases: readonly NarrowCase[],
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): Narrowed {
  const without = cases.filter((item) => !item.tests?.length).map((item) => item.key);
  if (cases.length === 0 || without.length > 0)
    return {
      reason: `у ${without.join(', ')} нет списка красных тестов ветки (последний прогон ветки зелёный, записан до списков или красных больше предела)`,
    };
  const all = cases.flatMap((item) => item.tests ?? []);
  if (all.some((test) => !test.name.trim() || test.name === BUILD_FAILURE))
    return { reason: 'у ветки упала сборка, а не тест — выбирать нечего' };
  const quote = (value: string) => shellQuote(value, platform);
  if (PYTEST.test(line)) return pytestLine(line, cases, exists, quote);
  if (GO_TEST.test(line)) return goLine(line, all, quote);
  if (new RegExp(VITEST.source).test(line)) return vitestLine(line, all, quote);
  return { reason: 'раннер команды не выбирает тесты (умеют pytest, go test, vitest)' };
}

function pytestLine(
  line: string,
  cases: readonly NarrowCase[],
  exists: (path: string) => boolean,
  quote: (value: string) => string,
): Narrowed {
  // node id — от корня проекта; команда, что уходит в другой каталог, читала бы их оттуда.
  if (/(?:^|[\s&|;(])(?:cd|pushd)\s/.test(line))
    return { reason: 'команда pytest меняет каталог — node id от корня проекта там не найдутся' };
  if (/::|\s-k(?:\s|=)|\s--deselect\b/.test(line))
    return { reason: 'команда pytest уже выбирает тесты сама' };
  let out = line;
  let count = 0;
  for (const item of cases) {
    const dir = clean(item.file);
    const ids: string[] = [];
    for (const test of item.tests ?? []) {
      const id = pytestNodeId(dir, test, exists);
      if (!id) return { reason: `тест ${test.name} не найден файлом в ${dir || '.'}` };
      if (!ids.includes(id)) ids.push(id);
    }
    const replaced = replaceToken(out, dir, ids.map(quote).join(' '));
    if (replaced === undefined) return { reason: `в команде нет каталога кейса ${dir || '.'}` };
    out = replaced;
    count += ids.length;
  }
  return { line: out, runner: 'pytest', tests: count };
}

/**
 * node id pytest по classname и имени: classname — модуль через точку от корня pytest
 * (ближайший pyproject.toml), а не от корня проекта, — поэтому начало classname
 * сверяется с хвостом каталога кейса (как `suiteByFile` импорта), дальше части — каталоги,
 * пока не найдётся файл `.py`; остальное — классы. Файл — только внутри каталога кейса.
 */
export function pytestNodeId(
  dir: string,
  test: ProjectTestFailedTest,
  exists: (path: string) => boolean,
): string | undefined {
  const parts = (test.owner ?? '').split('.').filter(Boolean);
  if (parts.length === 0) return undefined;
  const segments = dir ? dir.split('/').filter(Boolean) : [];
  const join = (...items: string[]) => items.filter(Boolean).join('/');
  for (let size = Math.min(segments.length, parts.length - 1); size >= 0; size -= 1) {
    if (segments.slice(segments.length - size).join('.') !== parts.slice(0, size).join('.'))
      continue;
    let base = join(...segments.slice(0, segments.length - size));
    for (let index = 0; index < parts.length; index += 1) {
      const file = join(base, `${parts[index]}.py`);
      if (exists(file)) {
        if (dir && !file.startsWith(`${dir}/`)) break;
        return [file, ...parts.slice(index + 1), test.name].join('::');
      }
      base = join(base, parts[index] ?? '');
    }
  }
  return undefined;
}

/** Первое вхождение каталога словом — на `value`, остальные убраны; нет — undefined. */
function replaceToken(line: string, dir: string, value: string): string | undefined {
  let found = false;
  const tokens = line.split(/(\s+)/).map((token) => {
    if (/^\s*$/.test(token)) return token;
    const bare = clean(token.replace(/^["']|["']$/g, ''));
    if (bare !== (dir || '.')) return token;
    if (found) return '';
    found = true;
    return value;
  });
  return found
    ? tokens
        .join('')
        .replace(/[ \t]{2,}/g, ' ')
        .trimEnd()
    : undefined;
}

function goLine(
  line: string,
  tests: readonly ProjectTestFailedTest[],
  quote: (value: string) => string,
): Narrowed {
  if (/\s-run(?:\s|=)/.test(line)) return { reason: 'команда go test уже выбирает тесты (-run)' };
  // Подтест `TestA/case` — его корень: `-run` по корню гонит и подтесты, то же падение.
  const names = [...new Set(tests.map((test) => test.name.split('/')[0] ?? ''))];
  const bad = names.find((name) => !/^[A-Za-z_]\w*$/.test(name));
  if (bad !== undefined) return { reason: `имя теста Go «${bad}» не годится для -run` };
  const pattern = quote(`^(${names.join('|')})$`);
  return {
    line: line.replace(GO_TEST_HEAD, (match) => `${match} -run ${pattern}`),
    runner: 'go',
    tests: names.length,
  };
}

function vitestLine(
  line: string,
  tests: readonly ProjectTestFailedTest[],
  quote: (value: string) => string,
): Narrowed {
  if (/\s(?:-t|--testNamePattern)(?:\s|=)/.test(line))
    return { reason: 'команда vitest уже выбирает тесты (-t)' };
  // Имя JUnit vitest — «описание > тест»; `-t` сверяет полное имя через пробел, и
  // последняя часть в нём есть всегда.
  const names = [...new Set(tests.map((test) => test.name.split(' > ').at(-1)?.trim() ?? ''))];
  if (names.some((name) => !name)) return { reason: 'у теста vitest пустое имя' };
  const pattern = quote(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  return {
    line: line.replace(
      VITEST,
      (_match, head: string, run: string) => `${head}${run} -t ${pattern}`,
    ),
    runner: 'vitest',
    tests: names.length,
  };
}
