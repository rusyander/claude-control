/**
 * Родной вывод бэкенд-инструментов → JUnit XML, который понимает импорт.
 *
 * `go test -json` и обычный вывод `cargo test` есть у самого инструмента: перевод
 * здесь избавляет человека от стороннего конвертера (gotestsum, cargo-nextest),
 * без которого рецепт иначе не шёл бы вовсе. Сборка, упавшая до тестов, — тоже
 * результат: тест `(build)` с текстом ошибки, иначе прогон выглядел бы пустым
 * и «зелёным».
 */

/** Имя результата для сборки, упавшей до тестов. */
export const BUILD_FAILURE = '(build)';

const MAX_OUTPUT = 8000;

interface NativeCase {
  owner: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  seconds?: number;
  output: string;
  /** Строка-суть падения; нет — первая непустая строка вывода. */
  message?: string;
}

const escapeXml = (value: string): string =>
  value
    // Управляющие символы XML 1.0 не разрешает вовсе — разбор бы споткнулся.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const tail = (text: string): string =>
  text.length > MAX_OUTPUT ? `…${text.slice(-MAX_OUTPUT)}` : text;

function toJUnit(cases: NativeCase[]): string {
  const suites = new Map<string, NativeCase[]>();
  for (const item of cases) suites.set(item.owner, [...(suites.get(item.owner) ?? []), item]);
  const body = [...suites]
    .map(([owner, items]) => {
      const rows = items.map((item) => {
        const time = item.seconds !== undefined ? ` time="${item.seconds}"` : '';
        const head = `<testcase classname="${escapeXml(owner)}" name="${escapeXml(item.name)}"${time}`;
        if (item.status === 'passed') return `${head}/>`;
        if (item.status === 'skipped') return `${head}><skipped/></testcase>`;
        const output = tail(item.output.trim());
        const message = item.message ?? output.split('\n').find((line) => line.trim()) ?? 'failed';
        return `${head}><failure message="${escapeXml(message.trim().slice(0, 300))}">${escapeXml(output)}</failure></testcase>`;
      });
      return `<testsuite name="${escapeXml(owner)}" tests="${items.length}">${rows.join('')}</testsuite>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${body}\n</testsuites>\n`;
}

interface GoEvent {
  Action?: string;
  Package?: string;
  ImportPath?: string;
  Test?: string;
  Elapsed?: number;
  Output?: string;
  OutputType?: string;
  FailedBuild?: string;
}

/** Служебные строки раннера: `=== RUN`, `--- FAIL: …` — в тексте падения шум. */
const GO_FRAME = /^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (PASS|FAIL|SKIP):)/;

/**
 * `go test -json`: события по строке. Результат теста — `pass`/`fail`/`skip` с
 * полем `Test`, его вывод — `output` того же теста. Пакет упал, а ни один его
 * тест — нет: сборка или `TestMain`; это один результат `(build)` с выводом
 * сборки — `build-output` с Go 1.24 (ключ — `ImportPath`, на него ссылается
 * `FailedBuild` пакета), раньше — строки не-JSON в том же потоке.
 */
export function goTestJsonToJUnit(content: string): string {
  const cases = new Map<string, NativeCase>();
  const packageOutput = new Map<string, string>();
  const testOutput = new Map<string, string>();
  const errorLine = new Map<string, string>();
  const failedPackages = new Map<string, string | undefined>();
  const packagesWithFailures = new Set<string>();
  const loose: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: GoEvent;
    try {
      event = JSON.parse(line) as GoEvent;
    } catch {
      // Ошибки сборки старых версий Go идут текстом в тот же поток.
      loose.push(line);
      continue;
    }
    const pkg = event.Package ?? event.ImportPath ?? '';
    const output = event.Output ?? '';
    const frame = event.OutputType === 'frame' || GO_FRAME.test(output);
    if (event.Action === 'build-output' || (event.Action === 'output' && !event.Test)) {
      if (!frame) packageOutput.set(pkg, (packageOutput.get(pkg) ?? '') + output);
      continue;
    }
    if (!event.Test) {
      if (event.Action === 'fail') failedPackages.set(pkg, event.FailedBuild);
      continue;
    }
    const key = `${pkg}\u0000${event.Test}`;
    if (event.Action === 'output') {
      if (!frame) testOutput.set(key, (testOutput.get(key) ?? '') + output);
      // `t.Errorf`/`t.Fatal` Go 1.24+ помечает `error`: это суть падения, а
      // не `t.Logf` перед ней.
      if (event.OutputType === 'error' && !errorLine.has(key)) errorLine.set(key, output.trim());
      continue;
    }
    if (event.Action !== 'pass' && event.Action !== 'fail' && event.Action !== 'skip') continue;
    const status =
      event.Action === 'pass' ? 'passed' : event.Action === 'fail' ? 'failed' : 'skipped';
    if (status === 'failed') packagesWithFailures.add(pkg);
    cases.set(key, {
      owner: pkg,
      name: event.Test,
      status,
      ...(typeof event.Elapsed === 'number' ? { seconds: event.Elapsed } : {}),
      output: '',
    });
  }
  for (const [key, item] of cases) {
    item.output = testOutput.get(key) ?? '';
    const error = errorLine.get(key);
    if (error) item.message = error;
  }
  for (const [pkg, build] of failedPackages) {
    if (packagesWithFailures.has(pkg)) continue;
    // Причины сборки пакета разложены по `ImportPath` зависимостей — собираются
    // все его секции `# <пакет>`; не подписан ни одной — весь вывод `FailedBuild`.
    const own = build
      ? [...packageOutput]
          .filter(([key]) => key !== pkg)
          .map(([, out]) => ownBuildSections(out, pkg))
          .filter(Boolean)
      : [];
    const shared = build ? (packageOutput.get(build) ?? '') : '';
    const text = [own.join('\n') || shared, packageOutput.get(pkg) ?? ''];
    cases.set(`${pkg}\u0000${BUILD_FAILURE}`, {
      owner: pkg,
      name: BUILD_FAILURE,
      status: 'failed',
      output: [...text, loose.join('\n')].filter((part) => part.trim()).join('\n'),
    });
  }
  return toJUnit([...cases.values()]);
}

/**
 * Вывод сборки бывает общим на несколько пакетов: при недостающей записи
 * `go.sum` Go отдаёт его по `ImportPath` модуля зависимости, а `FailedBuild`
 * пакета ссылается на один из них. Секции там подписаны `# <пакет>` — пакету
 * достаются только свои, иначе каталог показывал бы ошибку соседа.
 */
function ownBuildSections(text: string, pkg: string): string {
  const own: string[] = [];
  let mine = false;
  for (const line of text.split('\n')) {
    const header = /^# (\S+)/.exec(line);
    if (header) mine = header[1] === pkg;
    if (mine) own.push(line);
  }
  return own.join('\n').trim();
}

const CARGO_RUNNING = /^\s*Running (?:unittests )?(\S+)/;
const CARGO_DOCTESTS = /^\s*Doc-tests (\S+)/;
const CARGO_TEST = /^test (.+?) \.\.\. (ok|FAILED|ignored\b.*)$/;
const CARGO_SECTION = /^---- (.+?) std(?:out|err) ----$/;
const CARGO_BUILD_ERROR = /^error(?:\[E\d+\])?:/;
const CARGO_TESTS_FAILED = /^error: (?:test failed|\d+ targets? failed)/;

/**
 * Обычный вывод `cargo test` вместе с потоком ошибок (`2>&1`): строки
 * `Running unittests src/lib.rs (…)` называют файл набора — он становится
 * classname, а с ним и путь автотеста кейса. Текст падения — из секций
 * `---- имя stdout ----`, которые cargo печатает после прогона набора.
 */
export function cargoTestToJUnit(content: string): string {
  const cases: NativeCase[] = [];
  const byKey = new Map<string, NativeCase>();
  let owner = '';
  let section: NativeCase | undefined;
  const buildErrors: string[] = [];
  let inBuildError = false;
  let compileFailed = false;
  let afterPanic = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const running = CARGO_RUNNING.exec(line) ?? CARGO_DOCTESTS.exec(line);
    if (running) {
      // На Windows cargo пишет `src\lib.rs`: путь кейса — всегда через `/`.
      const target = (running[1] ?? '').split('\\').join('/');
      owner = CARGO_DOCTESTS.test(line) ? `doc-tests ${target}` : target;
      section = undefined;
      inBuildError = false;
      continue;
    }
    const test = CARGO_TEST.exec(line);
    if (test) {
      const name = test[1] ?? '';
      const verdict = test[2] ?? '';
      const item: NativeCase = {
        owner,
        name,
        status: verdict === 'ok' ? 'passed' : verdict === 'FAILED' ? 'failed' : 'skipped',
        output: '',
      };
      cases.push(item);
      byKey.set(`${owner}\u0000${name}`, item);
      continue;
    }
    const header = CARGO_SECTION.exec(line);
    if (header) {
      section = byKey.get(`${owner}\u0000${header[1] ?? ''}`);
      continue;
    }
    if (section) {
      // Секция кончается списком имён упавших — `failures:` или итогом набора.
      if (/^(failures:|test result:)/.test(line)) {
        section = undefined;
        continue;
      }
      // Суть падения — строка после `panicked at …`: там текст assert'а.
      if (afterPanic && line.trim() && !section.message) section.message = line.trim();
      afterPanic = / panicked at /.test(line);
      section.output += `${raw}\n`;
      continue;
    }
    // `error: test failed, to rerun…` и `error: 2 targets failed` — итог упавших
    // тестов, а не сборки: они уже посчитаны строками `test … FAILED`.
    if (CARGO_BUILD_ERROR.test(line) && !CARGO_TESTS_FAILED.test(line)) inBuildError = true;
    if (inBuildError) buildErrors.push(raw);
    if (/^error: could not compile/.test(line)) compileFailed = true;
  }
  if (compileFailed) {
    cases.push({
      owner: owner || 'cargo',
      name: BUILD_FAILURE,
      status: 'failed',
      output: buildErrors.join('\n'),
    });
  }
  return toJUnit(cases);
}
