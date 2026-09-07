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
 *   node tools/tests-cli.mjs show gui-001
 *   node tools/tests-cli.mjs run --group e2e
 *   node tools/tests-cli.mjs import --format junit --file test-results/junit.xml
 *   node tools/tests-cli.mjs export --group gui --format md --out gui.md
 *   node tools/tests-cli.mjs report --reporter junit --out report.xml
 *
 * Коды возврата рассчитаны на CI: `report` отвечает 1, если есть провалённые
 * или заблокированные кейсы ВНЕ карантина, `run` — кодом самой команды прогона.
 * Кейс в карантине печатается отдельным списком и сборку не роняет: команда уже
 * решила, что он сейчас не сторожевой.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  ['playwright', 'test-results/results.json'],
  ['playwright', 'playwright-report/results.json'],
  ['allure', 'allure-results'],
];

const HELP = `Тест-кейсы проекта без панели.

  list      группы и кейсы со статусами
  show      один кейс целиком: show <caseId>
  run       прогнать автотесты кейсов и забрать результаты
  import    забрать результаты прогона или кейсы из файла
  export    выгрузить группу в csv | md | xlsx
  report    сводка по статусам; --reporter junit — XML для CI

Опции:
  --project <dir>   каталог проекта (по умолчанию текущий)
  --group <id>      только эта группа
  --format <f>      junit | playwright | allure | csv | xlsx | testrail-csv | testrail | allure-testops | md
  --file <f>        файл или каталог с отчётом (путь от корня проекта)
  --reporter <r>    text | junit — вид отчёта команды report
  --out <f>         писать результат в файл вместо экрана
  --cmd "<...>"     команда прогона (по умолчанию npm test из package.json)
  --results <f>     где прогон оставит отчёт (по умолчанию ищется сам)
  --dry             для run: показать, что было бы запущено, и выйти
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
  if (command === 'import') return await importFile(project, options);
  if (command === 'export') return await exportGroupFile(project, options);
  if (command === 'report') return await report(project, options);
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

/** Модуль домена по имени файла. Отдельной функцией — путь один на все команды. */
async function domain(name) {
  return await import(pathToFileURL(join(DOMAIN, `${name}.ts`)).href);
}

function parseArgs(argv) {
  const options = {};
  const positional = [];
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const name = item.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) options[name] = true;
      else {
        options[name] = next;
        index += 1;
      }
      continue;
    }
    if (!command) command = item;
    else positional.push(item);
  }
  return { command, options, positional };
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
    for (const item of group.cases) {
      const mark = STATUS_MARK[item.status] ?? '.';
      const automation = item.automation?.file ? ` → ${item.automation.file}` : '';
      const archived = item.archived ? ' (архив)' : '';
      console.log(`  ${mark} ${item.id.padEnd(12)} ${item.title}${automation}${archived}`);
    }
  }
  console.log('');
  console.log(summaryLine(groups));
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
  const command = options.cmd ?? projectTestCommand(project);
  const line = command.includes('{files}')
    ? command.replace('{files}', files.join(' '))
    : `${command} ${files.join(' ')}`;

  console.log(`Кейсов с автотестом: ${automated.length}, файлов: ${files.length}`);
  console.log(`Команда: ${line}`);
  if (options.dry) {
    printSkipped(skipped);
    return;
  }

  const started = Date.now();
  const result = spawnSync(line, { cwd: project, shell: true, stdio: 'inherit' });
  console.log(
    `\nКоманда завершилась с кодом ${result.status ?? 'нет кода'} за ${Math.round((Date.now() - started) / 1000)} с`,
  );

  const found = options.results
    ? [detectFormat(options.results, options.format), options.results]
    : findResults(project);
  if (!found) {
    console.log(
      'Отчёт прогона не найден — статусы не тронуты. Укажите его: --results <файл> [--format junit|playwright|allure]',
    );
    printSkipped(skipped);
    process.exit(result.status ?? 0);
  }

  const [format, file] = found;
  const { importResults } = await domain('import-results');
  const imported = importResults(project, { format, file: toProjectRelative(project, file) });
  printImport(imported, `Импортировано из ${file} (${format})`);
  printSkipped(skipped);
  process.exit(result.status ?? 0);
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

function isRed(item) {
  return item.status === 'failed' || item.status === 'blocked';
}

function redLine(group, item) {
  return `  X ${group.id}/${item.id} ${item.title}${item.note ? ` — ${item.note}` : ''}`;
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
