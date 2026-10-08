/**
 * Тест-кейсы проекта из терминала: `pnpm tests <команда>`.
 *
 * Зачем отдельный вход, когда есть панель. Кейсы живут ФАЙЛАМИ внутри
 * проверяемого проекта, и это главное свойство раздела: их видно тому, кто
 * открыл репозиторий, и они едут вместе с веткой. Значит, всё, что панель
 * делает с ними мышью, обязано быть доступно и без панели — иначе файлы
 * оказываются заложниками запущенного сервера, а в CI, где никакой панели нет,
 * их не прочитать вовсе.
 *
 * Разбор форматов НЕ дублируется: команда подгружает те же модули домена
 * (`apps/server/src/domains/project-tests/*`), которыми пользуется сервер. Node
 * читает TypeScript сам (22.6+ — с флагом, 22.18+ — без), поэтому вторая копия
 * разбора JUnit или CSV здесь не заводится: разъехавшись, две копии молча
 * ставили бы разные статусы на один и тот же отчёт.
 *
 *   node tools/tests-cli.mjs list --project .
 *   node tools/tests-cli.mjs sync --project .
 *   node tools/tests-cli.mjs show gui-001
 *   node tools/tests-cli.mjs run --group e2e
 *   node tools/tests-cli.mjs import --format junit --file test-results/junit.xml
 *   node tools/tests-cli.mjs export --group gui --format md --out gui.md
 *   node tools/tests-cli.mjs report --reporter junit --out report.xml
 *   node tools/tests-cli.mjs case --group auth --json '{"title":"…","steps":["…"],"codePaths":["src/auth"]}'
 *   node tools/tests-cli.mjs record auth:auth-001=passed auth:auth-002=failed --note "…"
 *
 * Коды возврата рассчитаны на CI: `report` отвечает 1, если есть провалённые
 * или заблокированные кейсы ВНЕ карантина, `run` — кодом самой команды прогона,
 * `diff` — 1 при НОВЫХ провалах (давно известная поломка не красит каждую
 * следующую сборку), `lint` — только если спросили `--fail-on <серьёзность>`.
 * Кейс в карантине печатается отдельным списком и сборку не роняет: команда уже
 * решила, что он сейчас не сторожевой.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DOMAIN = join(REPO, 'apps', 'server', 'src', 'domains', 'project-tests');

/** Где чужие прогоны обычно оставляют отчёт — по этим путям ищем, если не сказано. */
const DEFAULT_RESULTS = [
  ['junit', 'test-results/junit.xml'],
  ['junit', 'test-results/results.xml'],
  ['junit', 'junit.xml'],
  ['junit', 'test-results.xml'],
  ['junit', 'reports/junit.xml'],
  // Куда пишет отчёт папка e2e, заведённая панелью (`e2e-scaffold.ts`).
  ['junit', 'e2e/results/junit.xml'],
  ['playwright', 'test-results/results.json'],
  ['playwright', 'playwright-report/results.json'],
  ['allure', 'allure-results'],
];

const HELP = `Тест-кейсы проекта без панели.

  list      группы и кейсы со статусами
  show      один кейс целиком: show <caseId>
  sync      тесты папки e2e — в кейсы: новые заводятся, знакомым обновляется привязка
  run       прогнать автотесты кейсов и забрать результаты
  import    забрать результаты прогона или кейсы из файла
  export    выгрузить группу в csv | md | xlsx
  report    сводка по статусам; --reporter junit — XML для CI
  lint      замечания набора: дубликаты, черновики, кейсы без ожидания
  diff      что изменилось между прогонами: diff <база> <новый>
  plan      собрать план правилом: plan smoke | diff | release | flaky
  case      завести или обновить кейс (агент чата): --group <g> --json '<кейс>' | --file <f.json>
            кейс человека не переписывается — правка уходит черновиком на приёмку
  record    записать проверенное прогоном в историю: record <группа>:<кейс>=passed|failed|blocked|skipped …

Опции:
  --project <dir>   каталог проекта (по умолчанию текущий)
  --group <id>      только эта группа
  --format <f>      junit | playwright | allure | csv | xlsx | testrail-csv | testrail | allure-testops | md
  --file <f>        файл или каталог с отчётом (путь от корня проекта)
  --dir <d>         для sync: папка e2e (по умолчанию ищется сама)
  --reporter <r>    text | junit — вид отчёта команд report и diff
  --out <f>         писать результат в файл вместо экрана
  --cmd "<...>"     команда прогона (по умолчанию: кейсы папки e2e — её раннером,
                    иначе своя команда из .agent/tests/automation.json,
                    иначе npm test из package.json)
  --results <f>     где прогон оставит отчёт (по умолчанию ищется сам)
  --dry             для run: показать, что было бы запущено, и выйти
  --fail-on <s>     для lint: ронять сборку с этой серьёзности (error | warning | info)
  --budget <мин>    для plan: сколько минут отведено (у «дыма» по умолчанию 30)
  --release <веха>  для plan release: чью веху собирать
  --threshold <ч>   для plan flaky: порог стабильности, доля 0–1 или проценты
  --save            для plan: записать план в проект, а не только показать
  --json '<кейс>'   для case: кейс JSON-объектом (title, steps, expected, codePaths, automation, id — для правки)
  --note "<текст>"  для record: что именно проверено (ляжет заметкой на каждый кейс записи)
`;

main().catch((error) => {
  console.error(`Ошибка: ${error?.message ?? error}`);
  process.exit(1);
});

async function main() {
  if (relaunchIfNeeded()) return;

  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || options.help) {
    console.log(HELP);
    return;
  }

  const project = resolve(options.project ?? process.cwd());
  if (!existsSync(project)) throw new Error(`Каталог проекта не найден: ${project}`);

  if (command === 'list') return await listCases(project, options);
  if (command === 'show') return await showCase(project, positional[0]);
  if (command === 'run') return await runTests(project, options);
  if (command === 'sync') return await syncFolder(project, options);
  if (command === 'import') return await importFile(project, options);
  if (command === 'export') return await exportGroupFile(project, options);
  if (command === 'report') return await report(project, options);
  if (command === 'lint') return await lint(project, options);
  if (command === 'diff') return await diff(project, options, positional);
  if (command === 'plan') return await plan(project, options, positional);
  if (command === 'case') return await saveCase(project, options);
  if (command === 'record') return await recordResults(project, options, positional);
  throw new Error(`Неизвестная команда «${command}». Список — node tools/tests-cli.mjs help`);
}

/**
 * До 22.18 Node не читает TypeScript без флага — перезапускаем себя с ним.
 * Иначе команда падала бы на первом же `import` модуля домена, и человек читал
 * бы стек вместо ответа.
 */
function relaunchIfNeeded() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const needsFlag = major === 22 && minor < 18;
  if (!needsFlag || process.execArgv.includes('--experimental-strip-types')) return false;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

/**
 * Модуль домена по имени. Отдельной функцией — путь один на все команды. Модуль
 * с тестами лежит в своей папке (`store/store.ts`), одиночный — файлом рядом.
 */
async function domain(name) {
  const folded = join(DOMAIN, name, `${name}.ts`);
  const file = existsSync(folded) ? folded : join(DOMAIN, `${name}.ts`);
  return await import(pathToFileURL(file).href);
}

function parseArgs(argv) {
  // Опции-флаги: у них нет значения. Остальные ждут его следующим словом.
  // Внутри функции: `main()` зовётся раньше, чем дошла бы константа модуля.
  const FLAG_OPTIONS = new Set(['help', 'dry', 'save']);
  const options = {};
  const positional = [];
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const name = item.slice(2);
      if (FLAG_OPTIONS.has(name)) {
        options[name] = true;
        continue;
      }
      const next = argv[index + 1];
      // Следующий флаг на месте значения — не значение (Ф17): `--note --x`
      // раньше тихо терял заметку, и запись уходила без неё.
      if (next === undefined || next.startsWith('--')) {
        throw new Error(
          `--${name} ждёт значение${next === undefined ? '' : `, а следом «${next}»`}. Значение, начинающееся с «--», не принимается.`,
        );
      }
      options[name] = next;
      index += 1;
      continue;
    }
    if (!command) command = item;
    else positional.push(item);
  }
  return { command, options, positional };
}

/**
 * Файл кейса — только из проекта (Ф18): кейс потом гоняется без присмотра, и
 * его не должно быть можно подсунуть из любого места диска. Сравниваются
 * настоящие пути — ссылка изнутри проекта наружу тоже отказ.
 */
function projectFile(project, file) {
  const target = resolve(project, file);
  const real = (path) => (existsSync(path) ? realpathSync.native(path) : path);
  const inside = relative(real(project), real(target));
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`Файл кейса вне проекта: ${file}. Нужен путь внутри ${project}.`);
  }
  return target;
}

/** Группы проекта, при желании суженные до одной. */
async function groupsOf(project, options) {
  const { readGroups } = await domain('store');
  const all = readGroups(project);
  if (!options.group) return all;
  const picked = all.filter((group) => group.id === options.group);
  if (picked.length === 0) throw new Error(`Группы «${options.group}» в проекте нет.`);
  return picked;
}

const STATUS_MARK = {
  passed: '+',
  failed: 'X',
  skipped: '~',
  blocked: '!',
  running: '>',
  unknown: '.',
};

async function listCases(project, options) {
  const groups = await groupsOf(project, options);
  if (groups.length === 0) {
    console.log('В проекте нет ни одной группы кейсов (.agent/tests пуст).');
    return;
  }
  for (const group of groups) {
    if (group.error) {
      console.log(`\n[${group.id}] ${group.title} — файл сломан: ${group.error}`);
      continue;
    }
    console.log(`\n[${group.id}] ${group.title} — кейсов: ${group.cases.length}`);
    // Ширина — по самому длинному id группы: при постоянных 12 длинные id
    // (`panel-agent-003`) сдвигали названия, и столбец рвался.
    const width = Math.max(12, ...group.cases.map((item) => item.id.length));
    for (const item of group.cases) {
      const mark = STATUS_MARK[item.status] ?? '.';
      const automation = item.automation?.file ? ` → ${item.automation.file}` : '';
      const archived = item.archived ? ' (архив)' : '';
      console.log(`  ${mark} ${item.id.padEnd(width)} ${item.title}${automation}${archived}`);
    }
  }
  console.log('');
  console.log(summaryLine(groups));
}

/**
 * Кейс от агента чата: блок «Тесты» участвует в работе над продуктом, а не
 * только в прогонах раздела (решение владельца 30.09). Статус правкой описания
 * не ставится — его пишет `record`.
 */
async function saveCase(project, options) {
  const group = typeof options.group === 'string' ? options.group : '';
  if (!group) throw new Error("Нужна группа: case --group <id> --json '<кейс>'");
  const raw =
    typeof options.json === 'string'
      ? options.json
      : typeof options.file === 'string'
        ? readFileSync(projectFile(project, options.file), 'utf8')
        : '';
  if (!raw) throw new Error("Нужен кейс: --json '<кейс>' или --file <файл.json>");
  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Кейс не разобрался как JSON: ${error.message}`, { cause: error });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Кейс — JSON-объект с полем title');
  }
  const { agentUpsertCase } = await domain('agent-write');
  const result = agentUpsertCase(project, group, input, new Date().toISOString());
  if (result.kind === 'draft') {
    console.log(
      `Кейс ${result.caseId} написан человеком и не переписан: правка ушла черновиком ${result.runId} — её примет человек в разделе «Тесты».`,
    );
    return;
  }
  console.log(
    `${result.created ? 'Заведён' : 'Обновлён'} кейс ${group}:${result.testCase.id} — ${result.testCase.title}`,
  );
}

/**
 * Записать проверенное агентом чата прогоном в историю блока: «проверил» —
 * запись, которую видит раздел и проверка доставки группы, а не слова в ответе.
 */
async function recordResults(project, options, positional) {
  if (positional.length === 0) {
    throw new Error('Нужны результаты: record <группа>:<кейс>=passed|failed|blocked|skipped …');
  }
  const statuses = new Set(['passed', 'failed', 'blocked', 'skipped']);
  const note = typeof options.note === 'string' ? options.note.trim() : '';
  const results = positional.map((item) => {
    const match = /^([a-z0-9][a-z0-9-]*):([^=\s]+)=([a-z]+)$/.exec(item);
    if (!match || !statuses.has(match[3])) {
      throw new Error(
        `Не результат: «${item}». Вид — <группа>:<кейс>=passed|failed|blocked|skipped`,
      );
    }
    return {
      groupId: match[1],
      caseId: match[2],
      status: match[3],
      ...(note ? { note } : {}),
    };
  });
  const { recordAgentResults } = await domain('agent-write');
  const run = recordAgentResults(project, results, new Date().toISOString());
  const { passed, failed, blocked, skipped } = run.summary;
  console.log(
    `Прогон ${run.id} записан: зелёных ${passed}, красных ${failed}, заблокировано ${blocked}, пропущено ${skipped}.`,
  );
  if (failed + blocked > 0) process.exitCode = 1;
}

async function showCase(project, caseId) {
  if (!caseId) throw new Error('Нужен идентификатор кейса: show <caseId>');
  const { readGroups } = await domain('store');
  const { stepText } = await import(
    pathToFileURL(join(REPO, 'packages', 'contracts', 'src', 'test-format.ts')).href
  );

  for (const group of readGroups(project)) {
    const item = group.cases.find((entry) => entry.id === caseId);
    if (!item) continue;
    console.log(`${item.title}\n`);
    console.log(`Группа: ${group.id} (${group.file})`);
    console.log(`Статус: ${item.status}${item.lastRunAt ? ` от ${item.lastRunAt}` : ''}`);
    if (item.purpose) console.log(`Цель: ${item.purpose}`);
    if (item.area) console.log(`Зона: ${item.area}`);
    if (item.section) console.log(`Секция: ${item.section}`);
    if (item.precondition) console.log(`Предусловие: ${item.precondition}`);
    if (item.automation?.file) {
      console.log(
        `Автотест: ${item.automation.file}${item.automation.testName ? ` (${item.automation.testName})` : ''}`,
      );
    }
    if (item.steps.length > 0) {
      console.log('\nШаги:');
      item.steps.forEach((step, index) => console.log(`  ${index + 1}. ${stepText(step)}`));
    }
    if (item.expected) console.log(`\nОжидание: ${item.expected}`);
    if (item.note) console.log(`Заметка последнего прогона: ${item.note}`);
    if (item.failure) console.log(`Провал: ${failureText(item.failure)}`);
    return;
  }
  throw new Error(`Кейса «${caseId}» в проекте нет.`);
}

/**
 * Прогон автотестов: команду проекта запускаем как есть, а потом забираем её
 * отчёт. Кейсы без привязки к коду не «проваливаются» — они пропускаются с
 * названной причиной: молчаливое красное на неавтоматизированном кейсе было бы
 * враньём.
 */
/**
 * Сверка папки e2e с кейсами — тем же модулем, что кнопка «Обновить из папки».
 * Ей пользуется и агент чата: написал тест с меткой `[id]` — сверил — кейс в разделе.
 */
async function syncFolder(project, options) {
  const { syncE2eFolder } = await domain('e2e-sync');
  const dir = options.dir ? toProjectRelative(project, resolve(project, options.dir)) : undefined;
  const result = syncE2eFolder(project, new Date().toISOString(), dir ? { dir } : {});
  console.log(
    `Папка ${result.dir}: файлов ${result.files}, тестов ${result.tests}; ` +
      `новых кейсов ${result.added}, привязано ${result.linked}`,
  );
  if (result.groups.length > 0) console.log(`Заведены группы: ${result.groups.join(', ')}`);
  for (const item of result.skipped) console.log(`  пропущено ${item.file}: ${item.reason}`);
  for (const item of result.missing) {
    console.log(`  тест кейса ${item.groupId}/${item.caseId} исчез из ${item.file}`);
  }
}

async function runTests(project, options) {
  const groups = await groupsOf(project, options);
  const automated = [];
  const skipped = [];
  for (const group of groups) {
    for (const item of group.cases) {
      if (item.archived) continue;
      if (item.automation?.file) automated.push({ group: group.id, item });
      else skipped.push({ group: group.id, item });
    }
  }

  if (automated.length === 0) {
    console.log('Прогонять нечего: ни у одного кейса нет automation.file.');
    printSkipped(skipped);
    return;
  }

  const files = [...new Set(automated.map((entry) => entry.item.automation.file))];
  // Без --cmd тесты папки e2e идут той же командой, что у кнопки панели: из
  // каталога её конфига, раннером папки, с отчётом во временный файл. Запуск
  // из корня брал чужую версию Playwright и не находил тестов. Не папка —
  // своя команда проекта из automation.json (её же зовёт кнопка), и только
  // потом npm test.
  const plan = options.cmd
    ? commandPlan(options.cmd, files, project)
    : ((await e2ePlan(project, files)) ??
      (await automationPlan(project, files)) ??
      commandPlan(projectTestCommand(project), files, project));

  console.log(`Кейсов с автотестом: ${automated.length}, файлов: ${files.length}`);
  console.log(`Команда: ${plan.line}`);
  if (options.dry) {
    dropTemp(plan.temp);
    printSkipped(skipped);
    return;
  }

  const started = Date.now();
  const result = spawnSync(plan.line, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    shell: true,
    stdio: 'inherit',
    ...(plan.timeout ? { timeout: plan.timeout } : {}),
  });
  if (result.error?.code === 'ETIMEDOUT') {
    console.log(`\nПрогон дольше ${plan.timeout / 60_000} мин — остановлен.`);
  }
  const exitCode = result.status ?? undefined;
  console.log(
    `\nКоманда завершилась с кодом ${exitCode ?? 'нет кода'} за ${Math.round((Date.now() - started) / 1000)} с`,
  );

  const found =
    plan.results ??
    (options.results
      ? [detectFormat(options.results, options.format), options.results]
      : findResults(project));
  if (!found) {
    console.log(
      'Отчёт прогона не найден — статусы не тронуты. Укажите его: --results <файл> [--format junit|playwright|allure]',
    );
    printSkipped(skipped);
    dropTemp(plan.temp);
    process.exit(result.status ?? 0);
  }

  const [format, file] = found;
  const path = isAbsolute(file) ? file : join(project, file);
  // Отчёт, которого ЭТОТ прогон не писал, — вчерашний: упавшая до тестов
  // команда «обновляла» бы кейсы и писала запись истории о прогоне, которого не было.
  if (!freshSince(path, started)) {
    console.log(
      `Отчёт ${file} старше этого прогона — команда его не написала. Статусы не тронуты, запись в историю не легла.`,
    );
    printSkipped(skipped);
    dropTemp(plan.temp);
    process.exit(result.status || 1);
  }

  const { importResults } = await domain('import-results');
  const imported = importResults(project, {
    format,
    ...(plan.temp
      ? { content: readFileSync(path, 'utf8') }
      : { file: toProjectRelative(project, file) }),
    origin: plan.origin,
    scope: `tests-cli run: ${plan.line}`,
    exitCode,
  });
  printImport(imported, `Импортировано из ${plan.temp ? 'отчёта прогона' : file} (${format})`);
  printSkipped(skipped);
  dropTemp(plan.temp);
  process.exit(result.status ?? 0);
}

/** Своя команда прогона: файлы — в `{files}` или в конец строки, запуск из корня. */
function commandPlan(command, files, project) {
  const line = command.includes('{files}')
    ? command.replace('{files}', files.join(' '))
    : `${command} ${files.join(' ')}`;
  return { line, cwd: project, env: {}, origin: 'ci' };
}

/**
 * Команда папки e2e, если все файлы кейсов лежат в ней. Раннер не установлен —
 * отказ словами: `npx` скачал бы его без спроса (однажды — 0,8 ГБ Cypress).
 */
async function e2ePlan(project, files) {
  const { e2eFolderView } = await domain('e2e-folder');
  const { e2eCommand, installedBin, runDirOf } = await domain('e2e-command');
  const folder = e2eFolderView(project);
  if (!folder.dir || folder.state === 'missing') return undefined;
  const prefix = `${folder.dir.replace(/\/+$/, '')}/`;
  if (!files.every((file) => file.startsWith(prefix))) return undefined;
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const report = join(temp, 'junit.xml');
  const command = e2eCommand(project, folder, report, files);
  if (!command) {
    dropTemp(temp);
    return undefined;
  }
  if (command.bin && !installedBin(command.cwd, command.bin)) {
    dropTemp(temp);
    throw new Error(
      `Раннер автотестов не установлен, а сам он не ставится. Выполните в ${runDirOf(project, command)}: ${command.install}`,
    );
  }
  return {
    line: command.line,
    cwd: command.cwd,
    env: command.env,
    results: ['junit', report],
    temp,
    origin: 'e2e',
  };
}

/**
 * Своя команда проекта из `.agent/tests/automation.json` — та же, что у кнопки
 * панели: подстановки `{files}`/`{report}`, отчёт во временный файл через
 * `AGENTDECK_JUNIT_REPORT`. `files` — файлы кейсов с автотестом (группы, если задана). Сломанный файл —
 * отказ словами, а не тихий откат на npm test.
 */
async function automationPlan(project, files) {
  const { readAutomation, automationCommand } = await domain('automation');
  const { automation, error } = readAutomation(project);
  if (error) throw new Error(`.agent/tests/automation.json: ${error}`);
  if (!automation) return undefined;
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const own = automationCommand(project, automation, files, join(temp, 'junit.xml'));
  return {
    line: own.line,
    cwd: own.cwd,
    env: own.env,
    results: ['junit', own.report],
    temp,
    origin: 'e2e',
    ...(automation.timeoutMinutes ? { timeout: automation.timeoutMinutes * 60_000 } : {}),
  };
}

/** Файл или каталог (Allure) изменён не раньше старта прогона. */
function freshSince(path, started) {
  try {
    const stat = statSync(path);
    const newest = stat.isDirectory()
      ? Math.max(
          stat.mtimeMs,
          ...readdirSync(path).map((name) => statSync(join(path, name)).mtimeMs),
        )
      : stat.mtimeMs;
    return newest >= started - 1000;
  } catch {
    return false;
  }
}

function dropTemp(temp) {
  if (temp) rmSync(temp, { recursive: true, force: true });
}

function printSkipped(skipped) {
  if (skipped.length === 0) return;
  console.log(`\nПропущено кейсов без автотеста: ${skipped.length}`);
  for (const entry of skipped.slice(0, 20)) {
    console.log(`  ~ ${entry.group}/${entry.item.id} — нет automation.file, проверяется вручную`);
  }
  if (skipped.length > 20) console.log(`  … и ещё ${skipped.length - 20}`);
}

/** Команда прогона проекта: та, что записана у него в package.json. */
function projectTestCommand(project) {
  const manifest = join(project, 'package.json');
  if (existsSync(manifest)) {
    try {
      const data = JSON.parse(readFileSync(manifest, 'utf8'));
      if (data?.scripts?.test) return 'npm test --';
    } catch {
      // Битый package.json — не повод падать: скажем то же, что и при его отсутствии.
    }
  }
  throw new Error(
    'Не из чего взять команду прогона: в package.json проекта нет scripts.test. Передайте --cmd "<команда>".',
  );
}

function findResults(project) {
  for (const [format, candidate] of DEFAULT_RESULTS) {
    if (existsSync(join(project, candidate))) return [format, candidate];
  }
  return undefined;
}

function detectFormat(file, explicit) {
  if (explicit && explicit !== true) return explicit;
  if (file.endsWith('.xml')) return 'junit';
  if (file.endsWith('.json')) return 'playwright';
  return 'allure';
}

function toProjectRelative(project, file) {
  const path = isAbsolute(file) ? relative(project, file) : file;
  return path.split('\\').join('/');
}

async function importFile(project, options) {
  const format = options.format;
  if (!format || format === true) {
    throw new Error(
      'Нужен --format: junit | playwright | allure | csv | xlsx | testrail-csv | testrail | allure-testops',
    );
  }
  const file = options.file;
  if (!file || file === true) throw new Error('Нужен --file <путь>');
  const inside = toProjectRelative(project, file);

  if (format === 'junit' || format === 'playwright' || format === 'allure') {
    const { importResults } = await domain('import-results');
    return printImport(importResults(project, { format, file: inside }), 'Результаты приняты');
  }

  if (format === 'testrail' || format === 'allure-testops') {
    const { migrateTestRail, migrateAllureTestOps } = await domain('migrate');
    const content = readFileSync(resolveInside(project, file), 'utf8');
    const migrated =
      format === 'testrail'
        ? migrateTestRail(project, content)
        : migrateAllureTestOps(project, content);
    printImport(migrated, `Перенос завершён, группы: ${migrated.groups.join(', ')}`);
    return;
  }

  if (format === 'csv' || format === 'xlsx' || format === 'testrail-csv') {
    if (!options.group || options.group === true) {
      throw new Error('Нужен --group <id>: в какую группу класть кейсы.');
    }
    const { importCases } = await domain('import-cases');
    return printImport(
      importCases(project, { format, groupId: options.group, file: inside }),
      `Кейсы приняты в группу «${options.group}»`,
    );
  }
  throw new Error(`Неизвестный формат импорта: ${format}`);
}

function resolveInside(project, file) {
  return isAbsolute(file) ? file : join(project, file);
}

function printImport(result, title) {
  console.log(`\n${title}`);
  console.log(`  прочитано: ${result.read}`);
  console.log(`  обновлено кейсов: ${result.matched}`);
  if (result.created) console.log(`  заведено кейсов: ${result.created}`);
  if (result.runId) console.log(`  прогон: ${result.runId}`);
  if (result.unmatched?.length) {
    console.log(`  не сопоставлено (${result.unmatched.length}):`);
    for (const name of result.unmatched.slice(0, 20)) console.log(`    ? ${name}`);
    if (result.unmatched.length > 20) console.log(`    … и ещё ${result.unmatched.length - 20}`);
  }
}

async function exportGroupFile(project, options) {
  if (!options.group || options.group === true) throw new Error('Нужен --group <id>');
  const format = options.format && options.format !== true ? options.format : 'csv';
  const { exportGroup } = await domain('export-cases');
  const file = exportGroup(project, options.group, format);

  if (options.out && options.out !== true) {
    writeFileSync(resolve(options.out), file.body);
    console.log(`Выгружено: ${resolve(options.out)} (${file.body.length} байт)`);
    return;
  }
  if (format === 'xlsx') {
    throw new Error('Книга Excel двоичная — укажите, куда её писать: --out <файл>');
  }
  process.stdout.write(file.body.toString('utf8'));
}

async function report(project, options) {
  const groups = await groupsOf(project, options);
  const reporter = options.reporter && options.reporter !== true ? options.reporter : 'text';

  if (reporter === 'junit') {
    const { buildJUnitReport } = await domain('export-cases');
    const xml = buildJUnitReport(groups);
    if (options.out && options.out !== true) {
      writeFileSync(resolve(options.out), xml, 'utf8');
      console.log(`Отчёт записан: ${resolve(options.out)}`);
    } else process.stdout.write(xml);
    process.exit(failedCount(groups) > 0 ? 1 : 0);
  }

  const width = Math.max(8, ...groups.map((group) => group.id.length));
  console.log(`${'группа'.padEnd(width)}  всего  зелёных  красных  пропущено  не гоняли`);
  for (const group of groups) {
    const counts = countOf(group.cases);
    console.log(
      `${group.id.padEnd(width)}  ${String(counts.total).padStart(5)}  ${String(counts.passed).padStart(7)}` +
        `  ${String(counts.failed).padStart(7)}  ${String(counts.skipped).padStart(9)}  ${String(counts.unknown).padStart(9)}`,
    );
  }
  console.log(`\n${summaryLine(groups)}`);

  const red = groups.flatMap((group) =>
    group.cases.filter((item) => !item.archived && isRed(item)).map((item) => ({ group, item })),
  );
  const failing = red.filter(({ item }) => !item.muted);
  const muted = red.filter(({ item }) => item.muted);

  if (failing.length > 0) {
    console.log('\nКрасные кейсы:');
    for (const { group, item } of failing) console.log(redLine(group, item));
  }
  if (muted.length > 0) {
    // Карантин печатается отдельно и НИЖЕ: это не «ещё немного красного», а
    // список, к которому надо вернуться, — и сборку он не роняет намеренно.
    console.log('\nВ карантине (сборку не роняют):');
    for (const { group, item } of muted) {
      const why = item.muteReason ? ` — ${item.muteReason}` : '';
      console.log(`  ~ ${group.id}/${item.id} ${item.title}${why}`);
    }
  }
  process.exit(failing.length > 0 ? 1 : 0);
}

/** Серьёзности от строгой к мягкой — по ним и решают, ронять ли сборку. */
const SEVERITY_ORDER = ['error', 'warning', 'info'];

const SEVERITY_MARK = { error: 'X', warning: '!', info: '·' };

/**
 * Замечания набора.
 *
 * Линтер ничего не правит: он называет кейс, правило и то, чем это чинится в
 * панели. Сборку роняет только `--fail-on <серьёзность>`; без него команда
 * отвечает нулём, потому что «в наборе есть о чём подумать» и «это нельзя
 * выкладывать» — разные утверждения, и решает второе человек, а не линтер.
 */
async function lint(project, options) {
  const groups = await groupsOf(project, options);
  const { lintLibrary } = await domain('lint');
  const report = lintLibrary(groups);

  console.log(`Проверено кейсов: ${report.checked}`);
  if (report.byRule.length > 0) {
    console.log('');
    for (const row of report.byRule) {
      console.log(`  ${mark(row.severity)} ${row.rule} — ${row.title}: ${row.count}`);
    }
  }

  if (report.findings.length > 0) {
    console.log('\nЗамечания:');
    for (const item of report.findings) {
      const fix = item.fix ? ` [${item.fix.label}]` : '';
      console.log(
        `  ${mark(item.severity)} ${item.groupId}/${item.caseId} ${item.title} — ${item.message}${fix}`,
      );
    }
  }

  if (report.duplicates.length > 0) {
    console.log('\nПохожие кейсы:');
    for (const item of report.duplicates) {
      const near = item.similar
        .map((other) => `${other.groupId}/${other.caseId} (${Math.round(other.score * 100)}%)`)
        .join(', ');
      console.log(`  ~ ${item.groupId}/${item.caseId} ${item.title} ≈ ${near}`);
    }
  }

  if (report.findings.length === 0 && report.duplicates.length === 0) {
    console.log('\nЗамечаний нет.');
  }

  const failOn = options['fail-on'];
  if (!failOn || failOn === true) return;
  const limit = SEVERITY_ORDER.indexOf(String(failOn));
  if (limit < 0) throw new Error(`Серьёзности «${failOn}» не бывает: error | warning | info`);
  const counted = report.findings.filter(
    (item) => SEVERITY_ORDER.indexOf(item.severity) <= limit,
  ).length;
  if (counted > 0) {
    console.log(`\nЗамечаний уровня «${failOn}» и строже: ${counted} — сборка красная.`);
    process.exit(1);
  }
}

function mark(severity) {
  return SEVERITY_MARK[severity] ?? '·';
}

/**
 * Сравнение двух прогонов: diff <база> <новый>.
 *
 * Порядок аргументов важен, и если даты говорят обратное, прогоны меняются
 * местами ВСЛУХ: при перепутанном порядке новые провалы читались бы как
 * «починилось», а молчаливая перестановка скрыла бы и саму ошибку человека.
 */
async function diff(project, options, positional) {
  const [first, second] = positional;
  const groups = await groupsOf(project, options);
  const { readRun, readRuns } = await domain('runs-store');
  const { diffRuns, diffWithPrevious } = await domain('compare');

  let result;
  if (first && second) {
    const runA = readRun(project, first);
    const runB = readRun(project, second);
    if (!runA) throw new Error(`Прогона «${first}» в проекте нет.`);
    if (!runB) throw new Error(`Прогона «${second}» в проекте нет.`);

    const swapped = Date.parse(runB.startedAt) < Date.parse(runA.startedAt);
    const [from, to] = swapped ? [runB, runA] : [runA, runB];
    if (swapped) console.error(`Порядок поменян: «${from.id}» старше «${to.id}».`);
    result = diffRuns(from, to, groups);
  } else {
    // Один прогон — с ближайшим прошлым, у которого есть результаты; ни одного —
    // последний с результатами. Так же сравнивает панель, и CI после прогона
    // пишет просто `pnpm tests diff`, не выясняя идентификаторы.
    // Сравнивать не с чем — это не провал: код 1 только за новые провалы, а
    // первый прогон проекта в CI красным из-за пустой истории быть не должен.
    const nothing = (text) => {
      console.log(text);
      process.exit(0);
    };
    const latest = first ?? readRuns(project, 200).find((run) => run.results.length > 0)?.id;
    if (!latest) nothing('В истории нет прогонов с результатами: сравнивать не с чем.');
    try {
      result = diffWithPrevious(project, latest, undefined, groups);
    } catch (error) {
      if (error?.messageCode === 'compare-first-run') nothing(error.message);
      throw error;
    }
  }
  const reporter = options.reporter && options.reporter !== true ? options.reporter : 'text';

  if (reporter === 'junit') {
    const { buildRunDiffJUnit } = await domain('export-cases');
    const xml = buildRunDiffJUnit(result);
    if (options.out && options.out !== true) {
      writeFileSync(resolve(options.out), xml, 'utf8');
      console.log(`Сравнение записано: ${resolve(options.out)}`);
    } else process.stdout.write(xml);
    process.exit(result.newFailures.length > 0 ? 1 : 0);
  }

  console.log(`база:  ${runSide(result.from)}`);
  console.log(`новый: ${runSide(result.to)}`);
  if (result.warning) console.log(`\nОсторожно: ${result.warning}`);

  printDiffList('Новые провалы', result.newFailures, 'X');
  printDiffList('Починилось', result.fixed, '+');
  printDiffList('Красное и там и там', result.stillFailing, '!');
  printDiffList('Появилось', result.added, '>');
  printDiffList('Пропало', result.removed, '<');
  console.log(
    `\nБез изменений: ${result.untouched.length} · новых провалов: ${result.newFailures.length}`,
  );
  process.exit(result.newFailures.length > 0 ? 1 : 0);
}

const ORIGIN_TEXT = { e2e: 'автотесты панели', ci: 'импорт из CI' };

/** Одна сторона сравнения строкой: по ней и видно, что с чем сравнили. */
function runSide(item) {
  const parts = [`${item.id} от ${item.startedAt.slice(0, 16).replace('T', ' ')}`];
  parts.push(`режим ${item.mode}`);
  // Импорт бывает двух родов, и «режим import» их не различал: прогон автотестов
  // панелью и отчёт сборки. Поле ставит сервер по одному правилу — `runOrigin`.
  if (item.origin) parts.push(ORIGIN_TEXT[item.origin] ?? item.origin);
  if (item.planId) parts.push(`план ${item.planId}`);
  if (item.environmentId) parts.push(`окружение ${item.environmentId}`);
  if (item.release) parts.push(`веха ${item.release}`);
  return parts.join(' · ');
}

function printDiffList(title, items, sign) {
  if (items.length === 0) return;
  console.log(`\n${title}: ${items.length}`);
  for (const item of items) {
    const note = item.note ? ` — ${item.note}` : '';
    console.log(`  ${sign} ${item.groupId}/${item.caseId} ${item.title ?? ''}${note}`);
  }
}

/**
 * План по правилу — без панели и без агента.
 *
 * `diff` ходит в git тем же `impactOf`, что и панель; `release` и `flaky`
 * читают историю прогонов из файлов проекта. Требования Jira отсюда не
 * спрашиваются вовсе — токен живёт в панели, — поэтому `release` собирается по
 * красному с прошлой вехи и ГОВОРИТ об этом: план, молча потерявший требования,
 * выглядел бы полным.
 */
async function plan(project, options, positional) {
  const recipe = positional[0];
  const known = ['smoke', 'diff', 'release', 'flaky'];
  if (!recipe || !known.includes(recipe)) {
    throw new Error(`Нужно правило: plan ${known.join(' | ')}`);
  }

  const groups = await groupsOf(project, options);
  const { readRuns } = await domain('runs-store');
  const input = { recipe, groups, runs: readRuns(project, 50) };

  const budget = numberOption(options.budget, '--budget', 'число минут больше нуля');
  if (budget !== undefined && budget <= 0)
    throw new Error(`--budget ждёт число минут больше нуля, а пришло «${options.budget}».`);
  if (budget !== undefined) input.budget = budget;
  const threshold = numberOption(options.threshold, '--threshold', 'долю 0–1 или проценты 0–100');
  if (threshold !== undefined && (threshold <= 0 || threshold > 100))
    throw new Error(
      `--threshold ждёт долю 0–1 или проценты 0–100, а пришло «${options.threshold}».`,
    );
  // Порог принимаем и долей, и процентами: «--threshold 80» человек напишет
  // раньше, чем «0.8», а правило считает в долях.
  if (threshold !== undefined) input.threshold = threshold > 1 ? threshold / 100 : threshold;
  if (options.release && options.release !== true) input.release = String(options.release);

  if (recipe === 'diff') {
    const { impactOf } = await domain('impact');
    input.impact = impactOf(project, groups);
    console.log(`Задето правками файлов: ${input.impact.files.length}`);
  }
  if (recipe === 'release') {
    console.log('Требования Jira без панели не спрашиваются: в план вошло красное с прошлой вехи.');
  }

  const { buildPlanPreview, toPlan } = await domain('plan-recipes');
  const preview = buildPlanPreview(input);

  const budgetLine = preview.budget ? ` из ${preview.budget}` : '';
  console.log(
    `\n${preview.title} · кейсов ${preview.picked.length} · минут ${preview.minutes}${budgetLine}`,
  );
  for (const pick of preview.picked) {
    console.log(`  + ${pick.groupId}/${pick.caseId} ${pick.title} — ${pick.reason}`);
  }
  if (preview.left.length > 0) {
    console.log(`\nНе вошло: ${preview.left.length}`);
    for (const pick of preview.left) {
      console.log(`  - ${pick.groupId}/${pick.caseId} ${pick.title} — ${pick.reason}`);
    }
  }

  if (!options.save) {
    console.log('\nПлан не записан — добавьте --save, чтобы сохранить его в проект.');
    return;
  }
  if (preview.picked.length === 0)
    throw new Error('Записывать нечего: правило не выбрало ни кейса.');
  const { savePlan } = await domain('plans');
  const saved = savePlan(project, toPlan(preview), new Date().toISOString());
  console.log(`\nПлан записан: ${saved.id} — ${saved.title}`);
}

/**
 * Число из опции. Не число — отказ с именем опции: молча подставленное
 * значение по умолчанию («--budget abc» становился тридцатью минутами) давало
 * план не того размера, о котором просили, и никто этого не видел.
 */
function numberOption(value, name, what) {
  if (value === undefined) return undefined;
  const parsed = value === true ? NaN : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(parsed))
    throw new Error(`${name} ждёт ${what}, а пришло «${value === true ? '' : value}».`);
  return parsed;
}

function isRed(item) {
  return item.status === 'failed' || item.status === 'blocked';
}

function redLine(group, item) {
  // Причина — общая заметка, а без неё разбор провала: человек часто пишет
  // только к красному шагу, и строка без причины в логе CI ничего не называет.
  const reason = item.note || (item.failure ? failureText(item.failure, true) : '');
  return `  X ${group.id}/${item.id} ${item.title}${reason ? ` — ${reason}` : ''}`;
}

/** Разбор провала строкой: полной для `show`, короткой для строки отчёта. */
function failureText(failure, short = false) {
  if (short) {
    const where = failure.step ? `шаг ${failure.step}: ` : '';
    const wanted = failure.expected ? ` (ожидалось: ${failure.expected})` : '';
    return `${where}${failure.actual ?? 'провал'}${wanted}`;
  }
  const parts = [];
  if (failure.step) parts.push(`шаг ${failure.step}`);
  if (failure.expected) parts.push(`ожидалось: ${failure.expected}`);
  if (failure.actual) parts.push(`получилось: ${failure.actual}`);
  if (failure.retry === 'flaky') parts.push('попытки разошлись');
  return parts.join(' · ');
}

function countOf(cases) {
  const live = cases.filter((item) => !item.archived);
  return {
    total: live.length,
    passed: live.filter((item) => item.status === 'passed').length,
    // Красный кейс в карантине остаётся красным в таблице — врать о статусе
    // нельзя. Из счёта, которым гейтят CI (`failedCount`), он вычтен.
    failed: live.filter((item) => isRed(item)).length,
    muted: live.filter((item) => item.muted).length,
    skipped: live.filter((item) => item.status === 'skipped').length,
    unknown: live.filter((item) => item.status === 'unknown' || item.status === 'running').length,
  };
}

/** Провалы, которыми гейтят CI: карантин сюда не входит — в этом его смысл. */
function failedCount(groups) {
  return groups.reduce(
    (sum, group) =>
      sum + group.cases.filter((item) => !item.archived && isRed(item) && !item.muted).length,
    0,
  );
}

function summaryLine(groups) {
  const all = groups.flatMap((group) => group.cases);
  const counts = countOf(all);
  const quarantine = counts.muted > 0 ? ` · в карантине ${counts.muted}` : '';
  return `Всего кейсов: ${counts.total} · зелёных ${counts.passed} · красных ${counts.failed} · пропущено ${counts.skipped} · не гоняли ${counts.unknown}${quarantine}`;
}
