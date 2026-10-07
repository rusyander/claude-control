/**
 * Проверки, у которых вердикт — код выхода, одним отчётом JUnit: так их видит
 * раздел «Тесты».
 *
 * Зачем. Проверки этого репозитория — самостоятельные скрипты `tools/qa/*.mjs`
 * (Playwright библиотекой, итог = код выхода) плюс наборы vitest. Раздел
 * «Тесты» принимает результаты в общепринятом виде — отчётом JUnit, где тест
 * помечен идентификатором кейса `[<caseId>]`. Своего формата «для agentdeck»
 * здесь нет: этот запускатель лишь переводит «код выхода» в тот же JUnit,
 * какой пишет любой каркас, и годится любому проекту с такими проверками.
 *
 * Какие кейсы несёт файл, берётся из самой библиотеки (`.agent/tests/*.tests.json`,
 * поле `automation.file`): один скрипт часто проверяет несколько кейсов, а
 * импорт кладёт результат ровно на один кейс, — поэтому на каждый кейс файла
 * пишется свой `<testcase>` с `[caseId]` в имени.
 *
 * - `*.mjs|*.js|*.cjs` — запускается `node <файл>`; прошёл = код 0.
 * - `*.test.ts|*.test.tsx|*.spec.ts` — vitest своего пакета (ближайший
 *   `vitest.config.*` вверх по дереву), без покрытия: частичный прогон ниже
 *   порогов покрытия ронял бы весь набор. У кейса с `automation.testName`
 *   берётся ровно этот тест («описание > тест», как его зовёт vitest), без
 *   имени — худший итог по файлу.
 *
 *   node tools/qa/junit-run.mjs [--project .] [--out <junit.xml>] [--timeout-min 10]
 *     [--health <url>] <файл>...
 *
 * `--health` (или `JUNIT_RUN_HEALTH`) — адрес стенда: живая проверка ждёт его до
 * 90 с перед стартом, а красный итог, пока стенд пропадал, повторяется один раз;
 * не поднялся и повтор — `<skipped>` с причиной, а не провал.
 *
 * Путь отчёта: `--out`, иначе `AGENTDECK_JUNIT_REPORT`, иначе
 * `test-results/junit.xml`. Прошлый отчёт удаляется ДО запуска: упавший
 * запускатель не должен «вернуть» вчерашние результаты. Код выхода 1 — хоть
 * один провал.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};

const project = resolve(option('--project') ?? process.cwd());
const out = resolve(
  project,
  option('--out') ?? process.env.AGENTDECK_JUNIT_REPORT ?? 'test-results/junit.xml',
);
const timeoutMs = Number(option('--timeout-min') ?? 10) * 60_000;
// Адрес стенда, без которого живые проверки не имеют смысла. Без флага
// запускатель стенда не знает и судит только по коду выхода.
const health = option('--health') ?? process.env.JUNIT_RUN_HEALTH;
const files = [...new Set(args.filter((arg) => !arg.startsWith('--')).map(toRelative))];

if (files.length === 0) {
  console.error('Нечего запускать: передайте файлы проверок.');
  process.exit(2);
}

rmSync(out, { force: true });
mkdirSync(dirname(out), { recursive: true });

const linked = casesByFile(project);
const suites = [];
for (const file of files) suites.push(await runFile(file, linked.get(file) ?? []));

writeFileSync(out, toJUnit(suites), 'utf8');
const all = suites.flatMap((suite) => suite.cases);
const failed = all.filter((item) => item.status === 'failed');
const notRun = all.filter((item) => item.status === 'skipped').length;
console.log(
  `\njunit-run: файлов ${suites.length}, тестов ${all.length}, ` +
    `провалов ${failed.length}, не засчитано из-за стенда ${notRun} → ${relative(project, out)}`,
);
// exitCode, а не exit(): выход посреди закрытия сокетов fetch роняет Node на
// Windows (libuv `UV_HANDLE_CLOSING`, код 127).
process.exitCode = failed.length > 0 || notRun > 0 ? 1 : 0;

/** Стенд отвечает? Любой ответ ниже 500 (401 гейта тоже) — «жив». */
async function standUp() {
  if (!health) return true;
  try {
    const response = await fetch(health, { signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Дождаться стенда (dev-watch перезапускает сервер на каждой записи): до 90 с. */
async function waitStand() {
  for (let i = 0; i < 30; i += 1) {
    if (await standUp()) return true;
    await new Promise((done) => setTimeout(done, 3000));
  }
  return false;
}

function toRelative(file) {
  return relative(project, resolve(project, file)).split('\\').join('/');
}

/** Кейсы библиотеки по файлу автотеста: `automation.file` → [{caseId, testName}]. */
function casesByFile(root) {
  const dir = join(root, '.agent', 'tests');
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir).filter((item) => item.endsWith('.tests.json'))) {
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      // Битый файл группы — не повод молчать о прочих: библиотека сама его назовёт.
      continue;
    }
    for (const item of Array.isArray(data?.cases) ? data.cases : []) {
      const file = item?.automation?.file;
      if (!file || item.archived) continue;
      const key = toRelative(file);
      const list = map.get(key) ?? [];
      list.push({ caseId: item.id, testName: item.automation.testName });
      map.set(key, list);
    }
  }
  return map;
}

async function runFile(file, cases) {
  const absolute = join(project, file);
  if (!existsSync(absolute)) {
    return suiteOf(file, cases, { status: 'failed', message: `Файл проверки не найден: ${file}` });
  }
  if (/\.(test|spec)\.tsx?$/.test(file)) return runVitest(file, cases);
  if (/\.(mjs|cjs|js)$/.test(file)) return runNodeGuarded(file, cases);
  return suiteOf(file, cases, {
    status: 'failed',
    message: `Не знаю, чем запускать ${file}: ожидается .mjs/.js/.cjs или *.test.ts`,
  });
}

/**
 * Живая проверка под присмотром стенда. Красный итог, пока стенд лежал, — не
 * вердикт кейсу, а сбой окружения: такой прогон повторяется один раз на
 * поднявшемся стенде, и засчитывается повтор. Лёг и повтор — `<skipped>` с
 * причиной («не засчитано»), а не провал: иначе перезапуск сервера красил бы
 * кейсы дефектами, которых нет.
 */
async function runNodeGuarded(file, cases) {
  if (!(await waitStand())) {
    return suiteOf(file, cases, {
      status: 'skipped',
      message: `Стенд ${health} не отвечает 90 с — проверка не запускалась.`,
    });
  }
  const first = await runNode(file);
  if (first.passed || first.downSamples === 0) return suiteOf(file, cases, first.outcome);
  console.log(`  стенд пропадал во время проверки (${first.downSamples} опросов) — повтор`);
  if (!(await waitStand())) {
    return suiteOf(file, cases, {
      ...first.outcome,
      status: 'skipped',
      message: `Стенд лёг во время проверки и не поднялся. ${first.outcome.message}`,
    });
  }
  const second = await runNode(file);
  const note = `Первая попытка упала, пока стенд перезапускался (${first.downSamples} опросов без ответа).`;
  if (second.passed || second.downSamples === 0) {
    return suiteOf(file, cases, {
      ...second.outcome,
      output: `${note}\n${second.outcome.output}`,
      message: second.passed ? undefined : `${second.outcome.message}\n${note}`,
    });
  }
  return suiteOf(file, cases, {
    ...second.outcome,
    status: 'skipped',
    message: `Стенд перезапускался в обеих попытках — итог не засчитан. ${second.outcome.message}`,
  });
}

function runNode(file) {
  console.log(`\n▶ node ${file}`);
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [file], { cwd: project, windowsHide: true });
    let output = '';
    let downSamples = 0;
    let timedOut = false;
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const poll = health
      ? setInterval(async () => {
          if (!(await standUp())) downSamples += 1;
        }, 2000)
      : undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      process.stdout.write(tail(output, 30));
      const seconds = (Date.now() - started) / 1000;
      const passed = code === 0 && !timedOut;
      // Код 2 — «не проверено» (`NotChecked` в throwaway-stand.mjs): нет CLI или
      // стенд не поднялся. Это не дефект продукта — пропуск с причиной.
      const notChecked = code === 2 && !timedOut;
      console.log(
        `  код ${code ?? 'нет'}${timedOut ? ' (таймаут)' : ''} за ${Math.round(seconds)} с`,
      );
      done({
        passed,
        downSamples,
        outcome: {
          status: passed ? 'passed' : notChecked ? 'skipped' : 'failed',
          seconds,
          message: passed
            ? undefined
            : `${timedOut ? 'Таймаут. ' : ''}${notChecked ? 'Не проверено. ' : ''}Код выхода ${code ?? 'нет'}. ${verdictLines(output)}`,
          output: tail(output, 80),
        },
      });
    });
  });
}

function runVitest(file, cases) {
  const root = vitestRoot(dirname(join(project, file)));
  if (!root) {
    return suiteOf(file, cases, { status: 'failed', message: `Нет vitest.config.* над ${file}` });
  }
  const report = join(dirname(out), `vitest-${Date.now()}.xml`);
  const target = relative(root, join(project, file)).split('\\').join('/');
  console.log(`\n▶ vitest ${target} (в ${relative(project, root) || '.'})`);
  const started = Date.now();
  const result = spawnSync(
    'npx',
    [
      'vitest',
      'run',
      target,
      '--coverage.enabled=false',
      '--reporter=junit',
      `--outputFile=${report}`,
    ],
    { cwd: root, encoding: 'utf8', timeout: timeoutMs, shell: true, windowsHide: true },
  );
  const seconds = (Date.now() - started) / 1000;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!existsSync(report)) {
    return suiteOf(file, cases, {
      status: 'failed',
      seconds,
      message: `vitest не оставил отчёта (код ${result.status ?? 'нет'}). ${verdictLines(output)}`,
      output: tail(output, 80),
    });
  }
  const tests = parseJUnitCases(readFileSync(report, 'utf8'));
  rmSync(report, { force: true });
  console.log(
    `  тестов в файле ${tests.length}, код ${result.status ?? 'нет'} за ${Math.round(seconds)} с`,
  );

  const whole = worst(tests);
  const suite = { name: file, cases: [] };
  const targets = cases.length > 0 ? cases : [{ caseId: undefined, testName: undefined }];
  for (const { caseId, testName } of targets) {
    if (!testName) {
      suite.cases.push({ caseId, name: file, file, seconds, ...whole });
      continue;
    }
    const hit = tests.find((test) => same(test.name, testName));
    suite.cases.push(
      hit
        ? { caseId, name: `${file} › ${testName}`, file, ...hit }
        : {
            caseId,
            name: `${file} › ${testName}`,
            file,
            status: 'failed',
            message: `Тест «${testName}» не найден в отчёте vitest по ${file} (переименован?).`,
          },
    );
  }
  return suite;
}

function vitestRoot(start) {
  for (let dir = start; dir.startsWith(project); dir = dirname(dir)) {
    const names = [
      'vitest.config.ts',
      'vitest.config.mts',
      'vitest.config.js',
      'vitest.config.mjs',
    ];
    if (names.some((name) => existsSync(join(dir, name)))) return dir;
    if (dir === dirname(dir)) break;
  }
  return undefined;
}

/** Один итог на все кейсы файла — или один безымянный, когда файл ни к чему не привязан. */
function suiteOf(file, cases, outcome) {
  const targets = cases.length > 0 ? cases : [{ caseId: undefined }];
  return {
    name: file,
    cases: targets.map(({ caseId }) => ({ caseId, name: file, file, ...outcome })),
  };
}

function worst(tests) {
  const failed = tests.filter((test) => test.status === 'failed');
  if (failed.length > 0) {
    return {
      status: 'failed',
      message: failed.map((test) => `${test.name}: ${test.message ?? ''}`.trim()).join('\n'),
    };
  }
  if (tests.length === 0)
    return { status: 'failed', message: 'В отчёте vitest нет ни одного теста.' };
  return { status: 'passed' };
}

function parseJUnitCases(xml) {
  const list = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const name = decode(attributes.match(/\bname="([^"]*)"/)?.[1] ?? '');
    const time = Number(attributes.match(/\btime="([^"]*)"/)?.[1]);
    const failure = body.match(/<(failure|error)\b([^>]*)>?([\s\S]*?)(?:<\/\1>|$)/);
    const skipped = /<skipped\b/.test(body);
    list.push({
      name,
      seconds: Number.isFinite(time) ? time : undefined,
      status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      message: failure
        ? decode(failure[2].match(/\bmessage="([^"]*)"/)?.[1] ?? failure[3] ?? '').slice(0, 2000)
        : undefined,
    });
  }
  return list;
}

function same(left, right) {
  const norm = (value) => value.trim().toLowerCase().replace(/[›»>]/g, '>').replace(/\s+/g, ' ');
  return norm(left) === norm(right);
}

/** Строки, в которых скрипт сам назвал провал; иначе — хвост вывода. */
function verdictLines(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const marked = lines.filter((line) =>
    /✗|FAIL|ПРОБЛЕМ|Провалено|не работает|нет кнопки|^\s*-\s|Error/i.test(line),
  );
  return (marked.length > 0 ? marked : lines.slice(-10)).slice(0, 15).join('\n');
}

function tail(text, count) {
  const lines = text.split(/\r?\n/);
  return `${lines.slice(-count).join('\n')}\n`;
}

function decode(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Управляющие символы (цвета терминала), кроме табуляции и переводов строки. */
function isControl(char) {
  const code = char.charCodeAt(0);
  return code < 32 && code !== 9 && code !== 10 && code !== 13;
}

function escape(value) {
  // XML 1.0 не допускает управляющих символов вовсе — отчёт с ними не читается.
  const clean = [...String(value)].filter((char) => !isControl(char)).join('');
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toJUnit(list) {
  const body = list
    .map((suite) => {
      const failures = suite.cases.filter((item) => item.status === 'failed').length;
      const cases = suite.cases
        .map((item) => {
          // `[caseId]` в имени — общий знак связи теста с кейсом: его понимает
          // импорт раздела «Тесты» у любого проекта, как и свойство `case_id`.
          const name = item.caseId ? `[${item.caseId}] ${item.name}` : item.name;
          const time = item.seconds !== undefined ? ` time="${item.seconds.toFixed(3)}"` : '';
          const parts = [];
          if (item.caseId) {
            parts.push(
              `<properties><property name="case_id" value="${escape(item.caseId)}"/></properties>`,
            );
          }
          if (item.status === 'failed') {
            const message = escape((item.message ?? 'провал').split('\n')[0].slice(0, 300));
            parts.push(`<failure message="${message}">${escape(item.message ?? '')}</failure>`);
          } else if (item.status === 'skipped') {
            const reason = escape((item.message ?? '').split('\n')[0].slice(0, 300));
            parts.push(`<skipped message="${reason}">${escape(item.message ?? '')}</skipped>`);
          }
          if (item.output) parts.push(`<system-out>${escape(item.output)}</system-out>`);
          return `    <testcase classname="${escape(item.file)}" name="${escape(name)}"${time}>${parts.join('')}</testcase>`;
        })
        .join('\n');
      return `  <testsuite name="${escape(suite.name)}" tests="${suite.cases.length}" failures="${failures}">\n${cases}\n  </testsuite>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="junit-run">\n${body}\n</testsuites>\n`;
}
