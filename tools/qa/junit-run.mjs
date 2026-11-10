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
 * - `*.mjs|*.js|*.cjs` — запускается `node <файл>`; прошёл = код 0. У скрипта
 *   `automation.testName` — его собственные аргументы (`--topic core`): кейсы с
 *   одинаковыми аргументами идут одним запуском, кейс без них — запуском без
 *   аргументов, как раньше.
 * - `*.test.ts|*.test.tsx|*.spec.ts` — vitest своего пакета (ближайший
 *   `vitest.config.*` вверх по дереву), без покрытия: частичный прогон ниже
 *   порогов покрытия ронял бы весь набор. У кейса с `automation.testName`
 *   берётся ровно этот тест («описание > тест», как его зовёт vitest), без
 *   имени — худший итог по файлу.
 * - `<каталог>/` — кейс-набор каталога (`tests-cli suites`): vitest пакета ОДИН
 *   раз на все такие каталоги пакета, каждый тест — своим `<testcase>` с путём
 *   файла в classname, без `[caseId]`: импорт сам кладёт тест в ближайший набор
 *   (`suiteKeysOf`) и считает «✗ 3/40». Тесты чужих наборов из того же вызова
 *   vitest отбрасываются — прогон каталога не трогает кейсы, которых не просили.
 *
 * - `*.recorded.mjs` — записанный проход панели: `node <файл>` без аргументов, а `testName` кейса
 *   сверяется с именем, которое спек объявляет первой строкой, буква в букву.
 *
 *   node tools/qa/junit-run.mjs [--project .] [--out <junit.xml>] [--timeout-min 10]
 *     [--health <url>] [--max-failures <n>] <файл или каталог/>...
 *
 * `--max-failures` (или `JUNIT_RUN_MAX_FAILURES`) — после n проваленных тестов остальные файлы
 * не запускаются и ложатся `<skipped>` «не запускался»: повтор встаёт на первом расхождении.
 *
 * Список длиннее строки команды (cmd.exe режет её на 8191 знаке) панель кладёт
 * в файл и называет его в `AGENTDECK_TEST_FILES` — по строке на путь.
 *
 * `--health` (или `JUNIT_RUN_HEALTH`) — адрес стенда: живая проверка ждёт его до
 * 90 с перед стартом, а красный итог, пока стенд пропадал, повторяется один раз;
 * не поднялся и повтор — `<skipped>` с причиной, а не провал. «Пропадал» = два
 * опроса подряд без ответа и неудачная перепроверка с долгим ожиданием (`watchStand`).
 *
 * Путь отчёта: `--out`, иначе `AGENTDECK_JUNIT_REPORT`, иначе
 * `test-results/junit.xml`. Прошлый отчёт удаляется ДО запуска: упавший
 * запускатель не должен «вернуть» вчерашние результаты. Код выхода 1 — хоть
 * один провал.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** Записанный проход панели и его строка-метка — те же, что пишет `recorded/codegen.ts` сервера. */
const RECORDED_SUFFIX = '.recorded.mjs';
const RECORDED_MARK = '// recorded-test: ';
/** Живой набор vitest (`*.live.*`): идёт мимо журнала проверок — см. `liveEnv`. */
const LIVE_FILE = /\.live\.[^/\\]*$/;

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};

// Корень — в настоящем регистре диска: `--project "c:\…"` иначе доезжал до скриптов в cwd и в путях
// от него (`c:/Users/…`), и проверка, сверяющая свой путь с os.homedir() (`C:\Users\…`), краснела
// только под прогоном блока (kit-120/121, rule-injector.test.mjs).
const asked = resolve(option('--project') ?? process.cwd());
const project = existsSync(asked) ? realpathSync.native(asked) : asked;
const out = resolve(
  project,
  option('--out') ?? process.env.AGENTDECK_JUNIT_REPORT ?? 'test-results/junit.xml',
);
const timeoutMs = Number(option('--timeout-min') ?? 10) * 60_000;
// Адрес стенда, без которого живые проверки не имеют смысла. Без флага
// запускатель стенда не знает и судит только по коду выхода.
const health = option('--health') ?? process.env.JUNIT_RUN_HEALTH;
// После скольких проваленных тестов прогон встаёт (`--max-failures`, `JUNIT_RUN_MAX_FAILURES`);
// без флага — гонится всё, как раньше.
const maxFailures = positiveInt(
  option('--max-failures') ?? process.env.JUNIT_RUN_MAX_FAILURES,
  '--max-failures',
);
// Выбор кейсов — этому запуску, не его детям: тест, который сам поднимает junit-run над
// временной библиотекой, иначе унаследовал бы чужой список и не нашёл своих кейсов
// (прогон 717df261, 02.11: testing-103 красный только под `tests-cli run --case`).
const pickedRaw = process.env.AGENTDECK_TEST_CASES;
delete process.env.AGENTDECK_TEST_CASES;
const entries = [
  ...new Set([...args.filter((arg) => !arg.startsWith('--')), ...listedFiles()].map(toEntry)),
];
const files = entries.filter((entry) => !entry.endsWith('/'));
const dirs = entries.filter((entry) => entry.endsWith('/'));

if (entries.length === 0) {
  console.error('Нечего запускать: передайте файлы проверок.');
  process.exit(2);
}

rmSync(out, { force: true });
mkdirSync(dirname(out), { recursive: true });

const linked = casesByFile(project);
const suites = [];
for (const file of files) {
  // Предел провалов набран — остальные файлы не запускаются: повтор записанных проходов встаёт на
  // первом расхождении, и модель зовут ровно на него, а не на хвост, упавший следом (P180).
  if (halted()) suites.push(suiteOf(file, linked.get(file) ?? [], haltedOutcome()));
  else suites.push(await runFile(file, linked.get(file) ?? []));
}
if (halted())
  suites.push(...dirs.map((dir) => suiteOf(dir, linked.get(dir) ?? [], haltedOutcome())));
else suites.push(...runSuiteDirs(dirs, linked));

writeFileSync(out, toJUnit(suites), 'utf8');
const all = suites.flatMap((suite) => suite.cases);
const failed = all.filter((item) => item.status === 'failed');
// `it.skip` в самом тесте — решение автора теста, а не сбой прогона: в отчёте он
// пропущен, но ни счётчик «из-за стенда», ни код выхода его не видят (16.10:
// 17 таких тестов наборов красили зелёный прогон).
const authored = all.filter((item) => item.authoredSkip).length;
const skipped = all.filter((item) => item.status === 'skipped' && !item.authoredSkip);
const notRun = skipped.length;
// Пропуск бывает двух родов: проверка сказала «не проверено» сама (кодом 2 —
// нет CLI) или стенд лежал. Один счётчик «из-за стенда» на оба посылал
// человека чинить стенд, когда не хватало goose и kimi (foreign-steer, 10.10).
const notChecked = skipped.filter((item) => item.message?.startsWith('Не проверено.')).length;
const stopped = skipped.filter((item) => item.halted).length;
console.log(
  `\njunit-run: файлов ${suites.length}, тестов ${all.length}, провалов ${failed.length}, ` +
    `не проверено ${notChecked}, не засчитано из-за стенда ${notRun - notChecked - stopped}` +
    `${stopped > 0 ? `, не запускалось после предела провалов ${stopped}` : ''}` +
    `${authored > 0 ? `, пропущено самими тестами ${authored}` : ''} → ${relative(project, out)}`,
);
// exitCode, а не exit(): выход посреди закрытия сокетов fetch роняет Node на
// Windows (libuv `UV_HANDLE_CLOSING`, код 127).
process.exitCode = failed.length > 0 || notRun > 0 ? 1 : 0;

/** Целое больше нуля или пусто; иное — отказ до запуска, а не тихое «без предела». */
function positiveInt(raw, name) {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} ждёт целое больше нуля, пришло «${raw}».`);
    process.exit(2);
  }
  return value;
}

/** Предел провалов набран: проваленных тестов в уже прогнанных файлах не меньше `maxFailures`. */
function halted() {
  if (maxFailures === undefined) return false;
  const count = suites.flatMap((suite) => suite.cases).filter((item) => item.status === 'failed');
  return count.length >= maxFailures;
}

function haltedOutcome() {
  return {
    status: 'skipped',
    halted: true,
    message: `Не запускался: прогон остановлен на первом расхождении (--max-failures ${maxFailures}).`,
  };
}

/** Стенд отвечает? Любой ответ ниже 500 (401 гейта тоже) — «жив». `stop` обрывает ожидание. */
async function standUp(waitMs = 3000, stop) {
  if (!health) return true;
  const timeout = AbortSignal.timeout(waitMs);
  try {
    const response = await fetch(health, {
      signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Пауза, которую `stop` обрывает сразу. */
function pause(ms, stop) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    stop.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
  });
}

/**
 * Присмотр за стендом, пока идёт проверка. Стенд «пропадал», только когда два опроса подряд без
 * ответа И перепроверка с долгим ожиданием тоже не дозвалась: 09.11 настоящий провал testing-009
 * записался «стенд пропадал» после ОДНОГО пропущенного опроса — панель считала lint по 4487 кейсам
 * и не ответила за 3 с, хотя была жива. Перезапуск dev-watch закрывает порт — отказ приходит сразу,
 * и перепроверка его не спасает. Опросы идут друг за другом, не внахлёст.
 */
function watchStand() {
  const stop = new AbortController();
  let downSamples = 0;
  let streak = 0;
  const step = async () => {
    if (await standUp(3000, stop.signal)) return void (streak = 0);
    if (stop.signal.aborted) return;
    streak += 1;
    if (streak < 2) return;
    streak = 0;
    if (!(await standUp(15_000, stop.signal)) && !stop.signal.aborted) downSamples += 1;
  };
  const loop = (async () => {
    while (!stop.signal.aborted) {
      await pause(2000, stop.signal);
      if (!stop.signal.aborted) await step();
    }
  })();
  return {
    /**
     * Проверка кончилась. Упала, когда последний опрос уже не дозвался, — ещё один опрос и
     * перепроверка сейчас: проверка, упавшая из-за лёгшего стенда за секунды, иначе не успела бы
     * набрать два пропуска подряд.
     */
    async finish(passed) {
      stop.abort();
      await loop;
      if (passed || streak === 0) return downSamples;
      if (!(await standUp(3000)) && !(await standUp(15_000))) downSamples += 1;
      return downSamples;
    },
  };
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

/** Путь от корня; каталог — с `/` на конце (корень — `./`): так его зовёт кейс-набор. */
function toEntry(file) {
  const rel = toRelative(file);
  const dir = /[\\/]$/.test(file) || isDir(join(project, rel));
  return dir ? `${rel || '.'}/` : rel;
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Пути из файла `AGENTDECK_TEST_FILES`: панель кладёт туда список, не влезший в строку. */
function listedFiles() {
  const list = process.env.AGENTDECK_TEST_FILES;
  if (!list) return [];
  return readFileSync(list, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Выбранные кейсы (`tests-cli run --case`): `группа:кейс` через запятую в `AGENTDECK_TEST_CASES`.
 * Без выбора файл несёт все свои кейсы. С выбором — только выбранные: у `check-core-chat.mjs` пять
 * кейсов с разными аргументами (пять одноразовых панелей), и прогон двух из них гонял все пять,
 * упирался в предел 10 мин и клал оба в историю проваленными (прогон 3deb1cb9, 02.11).
 */
function pickedCases() {
  const raw = pickedRaw;
  if (!raw) return undefined;
  return new Set(
    raw
      .split(/[,\r\n]+/)
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

/** Кейсы библиотеки по файлу автотеста: `automation.file` → [{caseId, testName}]. */
function casesByFile(root) {
  const dir = join(root, '.agent', 'tests');
  const map = new Map();
  if (!existsSync(dir)) return map;
  const picked = pickedCases();
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
      // Группа — из поля файла: часть группы лежит в `<группа>--<часть>.tests.json`, а выбор
      // приходит как `chat:chat-011`, не `chat--p1:chat-011`.
      const group =
        typeof data?.group === 'string' ? data.group : name.slice(0, -'.tests.json'.length);
      if (picked && !picked.has(`${group}:${item.id}`)) continue;
      const key = /[\\/]$/.test(file) ? `${toRelative(file) || '.'}/` : toRelative(file);
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
  if (file.endsWith(RECORDED_SUFFIX)) return runRecorded(file, cases);
  if (/\.(mjs|cjs|js)$/.test(file)) return runNodeByArgs(file, cases);
  return suiteOf(file, cases, {
    status: 'failed',
    message: `Не знаю, чем запускать ${file}: ожидается .mjs/.js/.cjs или *.test.ts`,
  });
}

/**
 * Записанный проход панели (`*.recorded.mjs`, R3): `testName` кейса — не аргументы скрипта, а
 * ПОЛНОЕ имя теста, которое спек объявляет о себе первой строкой (`// recorded-test: …`).
 * Совпало буква в букву — один запуск без аргументов; нет — провал «тест не найден», а не
 * зелёный чужого спека: кейс, привязанный куском имени, иначе проходил бы на любом файле.
 */
async function runRecorded(file, cases) {
  const head = readFileSync(join(project, file), 'utf8').split(/\r?\n/, 1)[0] ?? '';
  const mark = head.startsWith(RECORDED_MARK) ? head.slice(RECORDED_MARK.length).trim() : '';
  const matching = cases.filter((item) => item.testName === mark);
  const lost = cases.filter((item) => item.testName !== mark);
  const suites = lost.map((item) =>
    suiteOf(file, [item], {
      status: 'failed',
      message: mark
        ? `Тест «${item.testName ?? ''}» не найден в ${file} (переименован?): спек объявляет «${mark}».`
        : `${file} не объявляет имени теста (строки «${RECORDED_MARK.trim()}» нет) — запишите сценарий заново.`,
    }),
  );
  if (matching.length > 0 || cases.length === 0) {
    suites.push(await runNodeGuarded(file, matching, []));
  }
  return { name: file, cases: suites.flatMap((suite) => suite.cases) };
}

/**
 * Один запуск скрипта на каждый набор аргументов: кейс темы справки (`--topic core`) проверяет
 * только свою тему, а не красится чужим отставанием; кейс без аргументов — полный прогон.
 */
async function runNodeByArgs(file, cases) {
  const groups = new Map();
  for (const item of cases.length > 0 ? cases : [{ caseId: undefined }]) {
    const key = (item.testName ?? '').split(/\s+/).filter(Boolean).join(' ');
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const suites = [];
  for (const [key, group] of groups) {
    const argv = key ? key.split(' ') : [];
    suites.push(await runNodeGuarded(file, group[0].caseId === undefined ? [] : group, argv));
  }
  return { name: file, cases: suites.flatMap((suite) => suite.cases) };
}

/**
 * Живая проверка под присмотром стенда. Красный итог, пока стенд лежал, — не
 * вердикт кейсу, а сбой окружения: такой прогон повторяется один раз на
 * поднявшемся стенде, и засчитывается повтор. Лёг и повтор — `<skipped>` с
 * причиной («не засчитано»), а не провал: иначе перезапуск сервера красил бы
 * кейсы дефектами, которых нет.
 */
async function runNodeGuarded(file, cases, argv) {
  if (!(await waitStand())) {
    return suiteOf(file, cases, {
      status: 'skipped',
      message: `Стенд ${health} не отвечает 90 с — проверка не запускалась.`,
    });
  }
  const first = await runNode(file, argv);
  if (first.passed || first.downSamples === 0) return suiteOf(file, cases, first.outcome);
  console.log(`  стенд пропадал во время проверки (${first.downSamples} опросов) — повтор`);
  if (!(await waitStand())) {
    return suiteOf(file, cases, {
      ...first.outcome,
      status: 'skipped',
      message: `Стенд лёг во время проверки и не поднялся. ${first.outcome.message}`,
    });
  }
  const second = await runNode(file, argv);
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

function runNode(file, argv) {
  console.log(`\n▶ node ${[file, ...argv].join(' ')}`);
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [file, ...argv], { cwd: project, windowsHide: true });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const watch = health ? watchStand() : undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', async (code) => {
      clearTimeout(timer);
      const downSamples = watch ? await watch.finish(code === 0 && !timedOut) : 0;
      process.stdout.write(tail(output, 30));
      const seconds = (Date.now() - started) / 1000;
      const passed = code === 0 && !timedOut;
      // Код 2 — «не проверено» (`NotChecked` в throwaway-stand.mjs): нет CLI или
      // стенд не поднялся. Это не дефект продукта — пропуск с причиной.
      const notChecked = (code === 2 || (!passed && Boolean(mutationBusy(output)))) && !timedOut;
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
  const result = spawnVitest(root, [target], report, LIVE_FILE.test(file) ? liveEnv() : undefined);
  const seconds = (Date.now() - started) / 1000;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const busy = result.status !== 0 ? mutationBusy(output) : undefined;
  if (busy) {
    rmSync(report, { force: true });
    console.log(`  стенд занят мутантами — не проверено`);
    return suiteOf(file, cases, {
      status: 'skipped',
      seconds,
      message: `Не проверено. ${busy} Повторите после конца mustfail.`,
      output: tail(output, 80),
    });
  }
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

  // Пропуск в отчёте vitest — решение самого теста (`it.skip`, `ctx.skip()`): стенда этот путь
  // не ждёт. 25.10 тест гонки, не поймавший гонку, звался «из-за стенда» и давал код 1 зелёному прогону.
  const own = (result) =>
    result.status === 'skipped'
      ? {
          ...result,
          message: result.message ?? 'Пропущен самим тестом (it.skip или ctx.skip()).',
          authoredSkip: true,
        }
      : result;
  const whole = worst(tests);
  const suite = { name: file, cases: [] };
  const targets = cases.length > 0 ? cases : [{ caseId: undefined, testName: undefined }];
  for (const { caseId, testName } of targets) {
    if (!testName) {
      suite.cases.push(own({ caseId, name: file, file, seconds, ...whole }));
      continue;
    }
    // Имя блока describe связывает кейс со всеми тестами под ним: красный любой — красный кейс.
    const nested = tests.filter((test) => under(test.name, testName));
    const hit =
      tests.find((test) => same(test.name, testName)) ??
      (nested.length > 0 ? worst(nested) : undefined);
    suite.cases.push(
      hit
        ? own({ caseId, name: `${file} › ${testName}`, file, ...hit })
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

/** Наборы-каталоги: по вызову vitest на пакет, а не на каталог — 300 наборов не 300 запусков. */
function runSuiteDirs(list, cases) {
  const known = new Set([...cases.keys()].filter((key) => key.endsWith('/')));
  const byRoot = new Map();
  const ran = [];
  for (const dir of list) {
    const root = vitestRoot(join(project, dir));
    if (!root) {
      ran.push(
        suiteOf(dir, cases.get(dir) ?? [], {
          status: 'failed',
          message: `Нет vitest.config.* над ${dir}`,
        }),
      );
      continue;
    }
    byRoot.set(root, [...(byRoot.get(root) ?? []), dir]);
  }
  for (const [root, group] of byRoot) ran.push(runVitestDirs(root, group, cases, known));
  return ran;
}

/**
 * Каталоги одного пакета одним vitest. Фильтр vitest — подстрока пути, он
 * захватывает и вложенные наборы; лишнее отсекается здесь: тест остаётся, только
 * если ближайший к нему набор библиотеки — из запрошенных. Длинный список
 * фильтров — весь пакет: строка `npx` тоже идёт через cmd.exe.
 */
function runVitestDirs(root, group, cases, known) {
  const base = relative(project, root).split('\\').join('/');
  const filters = group.map((dir) => {
    const rel = relative(root, join(project, dir)).split('\\').join('/');
    return rel ? `${rel}/` : '';
  });
  const whole = filters.includes('') || filters.join(' ').length > 6000;
  const report = join(dirname(out), `vitest-dirs-${Date.now()}.xml`);
  console.log(
    `\n▶ vitest ${whole ? 'весь пакет' : `каталогов: ${group.length}`} (в ${base || '.'})`,
  );
  const started = Date.now();
  const result = spawnVitest(root, whole ? [] : filters, report);
  const seconds = (Date.now() - started) / 1000;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const name = `${base || '.'} (наборы)`;
  // Как у одного файла: отказ mutation-guard — тесты не запускались, это не провал каталога
  // (06.11 набор panel-agent/ лёг красным «нет ни одного теста», пока шёл чужой mustfail).
  const busy = result.status !== 0 ? mutationBusy(output) : undefined;
  if (busy) {
    rmSync(report, { force: true });
    console.log(`  стенд занят мутантами — не проверено`);
    const skipped = {
      status: 'skipped',
      seconds,
      message: `Не проверено. ${busy} Повторите после конца mustfail.`,
      output: tail(output, 80),
    };
    return {
      name,
      cases: group.flatMap((dir) => suiteOf(dir, cases.get(dir) ?? [], skipped).cases),
    };
  }
  if (!existsSync(report)) {
    const failure = {
      status: 'failed',
      seconds,
      message: `vitest не оставил отчёта (код ${result.status ?? 'нет'}). ${verdictLines(output)}`,
      output: tail(output, 80),
    };
    return {
      name,
      cases: group.flatMap((dir) => suiteOf(dir, cases.get(dir) ?? [], failure).cases),
    };
  }
  const tests = parseJUnitCases(readFileSync(report, 'utf8'));
  rmSync(report, { force: true });
  const wanted = new Set(group);
  const seen = new Set();
  const suite = { name, cases: [] };
  for (const test of tests) {
    const file = base ? `${base}/${test.owner}` : test.owner;
    const owner = ownerSuite(file, known);
    if (!owner || !wanted.has(owner)) continue;
    seen.add(owner);
    suite.cases.push({ ...test, file, authoredSkip: test.status === 'skipped' });
  }
  // Набор без единого теста в отчёте — не «зелёный молча»: тесты каталога
  // переехали или не собрались, и человеку это надо увидеть.
  for (const dir of group.filter((item) => !seen.has(item))) {
    suite.cases.push(
      ...suiteOf(dir, cases.get(dir) ?? [], {
        status: 'failed',
        message: `В отчёте vitest нет ни одного теста каталога ${dir}.`,
      }).cases,
    );
  }
  console.log(
    `  тестов ${suite.cases.length}, наборов с тестами ${seen.size} из ${group.length}, ` +
      `код ${result.status ?? 'нет'} за ${Math.round(seconds)} с`,
  );
  return suite;
}

/** Ближайший к файлу набор-каталог библиотеки: `a/b/c.test.ts` → `a/b/`, потом `a/`, `./`. */
function ownerSuite(file, known) {
  let at = file;
  while (at) {
    const cut = at.lastIndexOf('/');
    at = cut < 0 ? '' : at.slice(0, cut);
    const key = at ? `${at}/` : './';
    if (known.has(key)) return key;
  }
  return undefined;
}

/**
 * vitest одной строкой: аргументы рядом с `shell: true` Node 24 помечает DEP0190 на
 * каждом вызове, а оболочка нужна ради npx.cmd на Windows.
 */
function spawnVitest(root, targets, report, env) {
  const line = [
    'npx vitest run',
    ...targets.map(quoteArg),
    '--coverage.enabled=false',
    '--reporter=junit',
    `--outputFile=${quoteArg(report)}`,
  ].join(' ');
  return spawnSync(line, {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: true,
    windowsHide: true,
    ...(env ? { env } : {}),
  });
}

/**
 * Живой набор (`*.live.*`, как `*.live.integration.test.ts` ядра и сервера): вердикт зависит от
 * того, чего нет в дереве, — стенд, Chromium, CLI. Журнал проверок (verify-ledger) повторяет
 * зелёный по неизменному дереву, и 09.11.2026 `recorded.integration` дважды «прошёл» за 3 с:
 * запись → повтор по стенду не шли. Такой файл идёт заново всегда — журнал снимается так же,
 * как его снимает mustfail: обычный вход вместо входа под замком и пустой замок. Признак
 * файла — `LIVE_FILE` в начале модуля (прогон идёт на верхнем уровне, до этой строки).
 */
function liveEnv() {
  return {
    ...process.env,
    AGENTDECK_VERIFY_LEDGER: 'off',
    AGENTDECK_VERIFY_LEDGER_LOCK: '',
    NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '').replace(
      /([\\/]bin[\\/])preload-locked\.cjs/g,
      '$1preload.cjs',
    ),
  };
}

/** cmd — двойные кавычки; sh — одинарные: в двойных он раскрывает `$` и обратные кавычки. */
function quoteArg(value) {
  if (process.platform === 'win32') return /[\s"&|<>^]/.test(value) ? `"${value}"` : value;
  return /^[\w./:@%+,=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function vitestRoot(start) {
  // `resolve` снимает хвостовой разделитель: от `apps/core/` корень иначе выходил `…\core\`, а от
  // `apps/core/src/` — `…\core`, и наборы одного пакета шли двумя прогонами всего пакета (07.11).
  for (let dir = resolve(start); dir.startsWith(project); dir = dirname(dir)) {
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
  // Все пропущены — не проверено ничего: зелёный здесь был бы вердиктом без единой проверки.
  if (tests.every((test) => test.status === 'skipped')) return { status: 'skipped' };
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
    const seconds = Number.isFinite(time) ? time : undefined;
    const message = failure
      ? decode(failure[2].match(/\bmessage="([^"]*)"/)?.[1] ?? failure[3] ?? '').slice(0, 2000)
      : undefined;
    list.push({
      name,
      // classname vitest — путь файла теста от корня пакета.
      owner: decode(attributes.match(/\bclassname="([^"]*)"/)?.[1] ?? ''),
      seconds,
      status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      message: message === undefined ? undefined : withSyncBlock(message, seconds),
    });
  }
  return list;
}

/**
 * Асинхронный тест vitest снимает ровно в срок; шедший вдвое дольше срока держал поток синхронно
 * (cpSync/spawnSync/Atomics.wait) — срок сработал, лишь когда поток освободился. 24.10.2026 такую
 * запись «Test timed out in 1000ms» группа прочла как медленный стенд и трижды повторила прогон.
 * Признак тот же, что у `tests-cli run`: «timed out in X ms» и длительность ≥ 2X.
 */
function withSyncBlock(message, seconds) {
  const limit = Number(message.match(/(?:Test|Hook) timed out in (\d+)\s*ms/)?.[1]);
  if (!limit || seconds === undefined || seconds * 1000 < 2 * limit) return message;
  const round = (ms) => Math.round(ms / 100) / 10;
  return (
    `Синхронная блокировка: тест шёл ${round(seconds * 1000)} с при пределе ${round(limit)} с — ` +
    'vitest не прерывает синхронный код: тест или его оснастка держит поток синхронным вызовом ' +
    '(cpSync/rmSync/spawnSync/execSync по большому дереву, Atomics.wait). Повтор прогона и ' +
    `больший testTimeout не помогут — ищи этот вызов в файле и его фикстурах. ${message}`
  );
}

function norm(value) {
  return value.trim().toLowerCase().replace(/[›»>]/g, '>').replace(/\s+/g, ' ');
}

function same(left, right) {
  return norm(left) === norm(right);
}

/** Тест лежит внутри блока describe с этим именем. */
function under(name, block) {
  return norm(name).startsWith(`${norm(block)} > `);
}

/**
 * Строка отказа `mutation-guard`: другой прогон mustfail подменяет файлы дерева, тест не запускался
 * на настоящем коде. Это занятый стенд, а не дефект — пропуск с причиной (29.10 параллельные зоны
 * ядра портили друг другу историю «провалами»).
 */
function mutationBusy(output) {
  return output.match(/mutation-guard: (?:mustfail \(pid|журнал mustfail)[^\n]*/)?.[0];
}

// Объявление функции, а не `const`: верхний уровень модуля зовёт verdictLines раньше этой строки.
function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

/**
 * Строки, в которых скрипт сам назвал провал, с подробностью под каждой; иначе — хвост вывода.
 * Подробность — строки глубже отступом сразу под отмеченной (`check(name, ok, detail)` стенда
 * пишет её строкой ниже): без неё в истории оставалось одно имя проверки, и причину красного
 * core-chat-012 под `tests-cli` прочитать было негде — полный отчёт лежит во временной папке (04.11).
 */
function verdictLines(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const isMarked = (line) =>
    /✗|FAIL|ПРОБЛЕМ|Провалено|не работает|нет кнопки|^\s*-\s|Error/i.test(line);
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < 15; i++) {
    if (!isMarked(lines[i])) continue;
    picked.push(lines[i]);
    const depth = indentOf(lines[i]);
    for (let j = i + 1, kept = 0; j < lines.length && kept < 3; j++, kept++) {
      if (indentOf(lines[j]) <= depth || isMarked(lines[j])) break;
      picked.push(lines[j].length > 400 ? `${lines[j].slice(0, 400)}…` : lines[j]);
    }
  }
  return (picked.length > 0 ? picked : lines.slice(-10)).join('\n');
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
