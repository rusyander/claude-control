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
 *   node tools/tests-cli.mjs run --case chat:chat-001,chat:chat-007
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
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
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
            кейс человека не переписывается — правка уходит черновиком на приёмку;
            правка по "id" — кейс целиком: поля, которых нет в JSON, не берутся из прежнего
            Кейс пишется для человека: заголовок — проверяемое поведение, шаг на поведение,
            ожидание шага — что видно (текст на экране, статус или поле ответа, содержимое
            файла, строка отчёта), а не «все проходят» / «работает» (это ловит lint, правило
            vague-case, и проверка конца хода); кейс на тест называет тест в ожидании (файл › тест)
  suites    каталоги с тестами — в кейсы-наборы (кейс на каталог, итог — худший тест); --dry — только счёт
  gate      пробелы хода агента: gate --since <ISO> [--changed-at <ISO>] <файл…>; код 1 — есть пробелы
            (его зовёт хук конца хода: правил код — кейс, прогон, запись)
  record    записать проверенное вручную (только ручные кейсы, в разделе — «вручную»):
            record <группа>:<кейс>=passed|failed|blocked|skipped …; автокейс — только run

Опции:
  --project <dir>   каталог проекта (по умолчанию текущий)
  --group <id>      только эта группа
  --case <g:id,…>   для run: только эти кейсы (группа:кейс через запятую; id без группы —
                    если он один такой в проекте)
  --format <f>      junit | playwright | allure | csv | xlsx | testrail-csv | testrail | allure-testops | md
  --file <f>        файл или каталог с отчётом (путь от корня проекта)
  --dir <d>         для sync: папка e2e (по умолчанию ищется сама)
  --reporter <r>    text | junit — вид отчёта команд report и diff
  --out <f>         писать результат в файл вместо экрана
  --cmd "<...>"     команда прогона (по умолчанию: кейсы папки e2e — её раннером,
                    кейсы *.test.ts(x), которые своя команда не прогонит (отчёт Go/Cargo
                    или её нет и нет scripts.test), — vitest ближайшего package.json,
                    иначе своя команда из .agent/tests/automation.json,
                    иначе npm test из package.json); {files}/{paths} — файлы кейсов
                    (нет подстановки — в конец строки), {report} — отчёт JUnit этого прогона
  --results <f>     где прогон оставит отчёт (по умолчанию ищется сам)
  --dry             для run: показать, что было бы запущено, и выйти
  --brief | --full  для run: вывод раннера — в журнал, на экран итог и первые строки падений
                    (группе панели — по умолчанию, AGENTDECK_BRIEF_OUTPUT=1) | весь, как есть
  --memo | --fresh  для run: зелёный итог на том же дереве — из памяти, без прогона (группе
                    панели — по умолчанию; e2e по стенду — всегда заново) | прогнать заново
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
  if (command === 'gate') return await turnGate(project, options, positional);
  if (command === 'suites') return await syncSuiteCases(project, options);
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
  const FLAG_OPTIONS = new Set([
    'help',
    'dry',
    'save',
    'brief',
    'full',
    'memo',
    'fresh',
    'defer-runs',
  ]);
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

/**
 * `run --case g:id,g:id` (L7.3 плана экономии групп): проверка доставки
 * группы просила прогнать кейсы её изменённых файлов, а давала команду без
 * выбора, и группа гоняла ВСЕ кейсы копии (128 с вместо секунд). Ключ —
 * «группа:кейс», как в истории; голый id принимается, если в проекте он один.
 * Неизвестный ключ — отказ словами: молча прогнать меньше просимого хуже.
 */
function pickedCases(groups, raw) {
  if (raw === undefined) return undefined;
  const wanted = String(raw)
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (wanted.length === 0) throw new Error('--case ждёт кейсы: группа:кейс через запятую.');
  const live = groups.flatMap((group) =>
    group.cases.filter((item) => !item.archived).map((item) => `${group.id}:${item.id}`),
  );
  const keys = new Set();
  const unknown = [];
  for (const key of wanted) {
    const match = key.includes(':')
      ? live.filter((full) => full === key)
      : live.filter((full) => full.slice(full.indexOf(':') + 1) === key);
    if (match.length === 1) keys.add(match[0]);
    else
      unknown.push(match.length > 1 ? `${key} (есть в нескольких группах — назовите группу)` : key);
  }
  if (unknown.length > 0) throw new Error(`Кейсов нет в проекте: ${unknown.join(', ')}`);
  return keys;
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
  if (result.requested) {
    console.log(
      `Кейса «${result.requested}» в группе не было — заведён новый ${group}:${result.testCase.id} — ${result.testCase.title}` +
        (result.similar
          ? `. Есть похожий ${group}:${result.similar}: если правка была для него, повторите её с этим id`
          : ''),
    );
    return;
  }
  console.log(
    `${result.created ? 'Заведён' : 'Обновлён'} кейс ${group}:${result.testCase.id} — ${result.testCase.title}`,
  );
}

/**
 * Файлы хода, которых git не отслеживает (3.4): по ним шлюз отличает подсобный
 * скрипт снимков от кода. Не репозиторий или git не ответил — список пуст, и
 * исключения нет: лишний пробел лучше пропущенного.
 */
function untrackedOf(project, paths) {
  if (paths.length === 0) return [];
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...paths], {
    cwd: project,
    encoding: 'utf8',
  });
  if (listed.status !== 0) return [];
  const tracked = new Set(listed.stdout.split('\0').filter(Boolean));
  return paths.filter((path) => !tracked.has(path));
}

/**
 * Пробелы хода агента (хук Stop, `tools/tests-hook.mjs`): правил код — кейс на
 * изменённое, прогон после правки, запись ручного. Пусто — молчит и выходит с 0.
 */
async function turnGate(project, options, positional) {
  const since = typeof options.since === 'string' ? options.since : '';
  if (!Number.isFinite(Date.parse(since)))
    throw new Error('Нужно начало хода: gate --since <ISO> <файл…>');
  const { judgeTurn } = await domain('turn-gate');
  const { readGroups } = await domain('store');
  const { readRuns } = await domain('runs-store');
  const paths = positional.map((file) => toProjectRelative(project, file));
  const gaps = judgeTurn({
    groups: readGroups(project),
    runs: readRuns(project),
    paths,
    untracked: untrackedOf(project, paths),
    since,
    ...(typeof options['changed-at'] === 'string' ? { changedAt: options['changed-at'] } : {}),
    ...(options['defer-runs'] ? { deferRuns: true } : {}),
    cli: `node "${fileURLToPath(import.meta.url)}"`,
    root: project,
  });
  for (const gap of gaps) console.log(gap);
  if (gaps.length > 0) process.exitCode = 1;
}

/**
 * Каталоги с тестами — в кейсы-наборы: кейс на каталог, результат — худший из
 * его тестов. Повтор заводит только новые каталоги.
 */
async function syncSuiteCases(project, options) {
  const { adoptRunCommand, syncSuites } = await domain('suites');
  const dry = Boolean(options.dry);
  const sync = syncSuites(project, new Date().toISOString(), dry);
  const adopted = adoptRunCommand(project, dry);
  console.log(`Каталогов с тестами: ${sync.suites}`);
  console.log(
    `${dry ? 'Будет заведено' : 'Заведено'} кейсов-наборов: ${sync.added}` +
      (sync.groups.length > 0 ? ` (группы: ${sync.groups.join(', ')})` : ''),
  );
  if (sync.refreshed > 0) {
    console.log(
      `${dry ? 'Будет переписано' : 'Переписано'} по нынешним тестам каталога: ${sync.refreshed}`,
    );
  }
  for (const item of sync.missing) {
    console.log(
      `  ~ ${item.groupId}/${item.caseId} — каталога ${item.dir} больше нет, кейс оставлен`,
    );
  }
  if (sync.truncated)
    console.log('Обход упёрся в потолок каталогов: часть проекта не просмотрена.');
  if (adopted)
    console.log(`${dry ? 'Командой прогона станет' : 'Команда прогона'} — рецепт ${adopted}`);
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
  let run;
  try {
    run = recordAgentResults(project, results, new Date().toISOString());
  } catch (error) {
    if (error?.messageCode !== 'record-automated-case') throw error;
    // Автокейс проверяет его тест: агенту — готовая команда, а не «нельзя».
    // Ровно эти кейсы, не их группа: группа может нести живые QA на стенде (L6.2).
    const cases = String(error.params.cases).split(', ').join(',');
    throw new Error(
      `автокейсы не записываются словом — ${error.params.cases}. Их проверяет тест, прогоните: node tools/tests-cli.mjs run --project "${project}" --case ${cases}`,
      { cause: error },
    );
  }
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

/**
 * Короткий вывод прогона (2.2 плана экономии, 17.10.2026). Агент группы читает
 * вывод команды в контекст, и каждый следующий вызов модели перечитывает его
 * заново: полный журнал гейта в 30 тыс. знаков стоил десятки перечитываний. В
 * короткой форме на экран идут первые строки падений и путь к журналу, где
 * лежит всё; итог и записи истории печатает импорт ниже — как без формы.
 * Метку ставит панель ребёнку разделения (`ChatRunner`, `BRIEF_OUTPUT_ENV`); имя
 * берётся из контрактов — литерал здесь разошёлся бы с панелью молча (ревью A2-F18).
 */
async function briefMarked() {
  const { BRIEF_OUTPUT_ENV } = await import(
    pathToFileURL(join(REPO, 'packages', 'contracts', 'src', 'chat-group-settings.ts')).href
  );
  return process.env[BRIEF_OUTPUT_ENV] === '1';
}
const BRIEF_MAX_BUFFER = 512 * 1024 * 1024;
const BRIEF_FAILURES = 15;
const FAILURE_LINE =
  /\b(FAIL|FAILED|ERROR|Error|AssertionError|failed|panic)\b|^\s*(×|✗|✘|●)\s|\s(×|✗|✘)\s/;

/** Журналов коротких прогонов хранится столько: старые убираются при записи нового. */
const BRIEF_LOGS_KEPT = 30;

/** Оставить свежие журналы: каждый — полный вывод гейта, за неделю групп — гигабайты. */
function pruneBriefLogs(dir) {
  try {
    const logs = readdirSync(dir)
      .filter((name) => name.startsWith('run-') && name.endsWith('.log'))
      .sort();
    for (const name of logs.slice(0, Math.max(0, logs.length - BRIEF_LOGS_KEPT))) {
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    // Чужой процесс держит файл (Windows) — уберётся при следующем прогоне.
  }
}

function briefOutput(result) {
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const dir = join(tmpdir(), 'agentdeck-tests-logs');
  mkdirSync(dir, { recursive: true });
  pruneBriefLogs(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = join(dir, `run-${stamp}-${process.pid}.log`);
  writeFileSync(log, text, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  // Зелёный прогон падений не печатает: «failed» и «Error» живут и в именах
  // проходящих тестов, и агент читал их как падения (ревью B2-F12).
  const failures =
    result.status === 0
      ? []
      : lines.filter((line) => FAILURE_LINE.test(line)).slice(0, BRIEF_FAILURES);
  return [
    ...(failures.length > 0
      ? ['Первые строки падений:', ...failures.map((line) => `  ${line.trim().slice(0, 300)}`)]
      : []),
    `Полный вывод (${lines.length} строк): ${log}`,
  ].join('\n');
}

async function runTests(project, options) {
  const groups = await groupsOf(project, options);
  const picked = pickedCases(groups, options.case);
  const automated = [];
  const skipped = [];
  for (const group of groups) {
    for (const item of group.cases) {
      if (item.archived) continue;
      if (picked && !picked.has(`${group.id}:${item.id}`)) continue;
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
      (await vitestPlan(project, files)) ??
      (await automationPlan(project, files, !options.group && !picked)) ??
      commandPlan(projectTestCommand(project), files, project));

  console.log(`Кейсов с автотестом: ${automated.length}, файлов: ${files.length}`);
  console.log(`Команда: ${plan.line}`);
  // Список длиннее строки cmd.exe ушёл файлом — иначе по строке выглядит, будто гонится всё.
  if (plan.listed) console.log(`Файлов прогона: ${plan.listed} — списком в AGENTDECK_TEST_FILES`);
  if (options.dry) {
    dropTemp(plan.temp);
    printSkipped(skipped);
    return;
  }

  const memo = await checkMemoOf(project, options, plan, files);
  const replay =
    memo?.hit && memo.replay(`tests-cli run (из памяти ${memo.hit.runId}): ${plan.line}`);
  if (replay) {
    console.log(
      `\nБез изменений с зелёного прогона ${memo.hit.runId} (${memo.hit.at}): файлы проекта те же, ` +
        `прогон не повторён, итог тот же — зелёный, записан в историю как ${replay.id}. Заново — с --fresh.`,
    );
    printSkipped(skipped);
    dropTemp(plan.temp);
    process.exit(0);
  }

  const started = Date.now();
  const brief = !options.full && (Boolean(options.brief) || (await briefMarked()));
  const result = spawnSync(plan.line, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    shell: true,
    stdio: brief ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    ...(brief ? { encoding: 'utf8', maxBuffer: BRIEF_MAX_BUFFER } : {}),
    ...(plan.timeout ? { timeout: plan.timeout } : {}),
  });
  if (brief) console.log(briefOutput(result));
  if (result.error?.code === 'ETIMEDOUT') {
    console.log(`\nПрогон дольше ${plan.timeout / 60_000} мин — остановлен.`);
  }
  const exitCode = result.status ?? undefined;
  console.log(
    `\nКоманда завершилась с кодом ${exitCode ?? 'нет кода'} за ${Math.round((Date.now() - started) / 1000)} с`,
  );

  // Своя команда проекта: отчёт может быть каталогом (Gradle, Maven) или родным
  // выводом (go test -json, cargo test) — тот же сбор, что у кнопки панели,
  // сводит его в один JUnit этого прогона.
  if (plan.collect) {
    const collected = plan.collect(started);
    if (!collected) {
      console.log(
        `Отчёт ${plan.reportShown} этим прогоном не записан — статусы не тронуты, запись в историю не легла.`,
      );
      if (plan.tail) console.log(plan.tail());
      printSkipped(skipped);
      dropTemp(plan.temp);
      process.exit(result.status || 1);
    }
    writeFileSync(join(plan.temp, 'collected.xml'), collected.content);
    plan.results = ['junit', join(plan.temp, 'collected.xml')];
  }

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

  const content = plan.temp ? readFileSync(path, 'utf8') : undefined;
  // Цепочка пакетов гасит код провала — красное из самого отчёта, и в историю тоже.
  const status = plan.failed?.(content) ? 1 : result.status;
  const { importResults } = await domain('import-results');
  const imported = importResults(project, {
    format,
    ...(content !== undefined ? { content } : { file: toProjectRelative(project, file) }),
    origin: plan.origin,
    scope: `tests-cli run: ${plan.line}`,
    exitCode: status ?? exitCode,
    // Прогон части (--group, --case) — результаты на кейсы этих групп: одинаковый
    // ключ набора двух пакетов на весь проект двусмыслен, и его результат терялся.
    ...(options.group || picked ? { groups: [...new Set(automated.map((e) => e.group))] } : {}),
  });
  printImport(imported, `Импортировано из ${plan.temp ? 'отчёта прогона' : file} (${format})`);
  memo?.settle(status === 0 && imported.read > 0 ? imported.runId : undefined);
  printSkipped(skipped);
  dropTemp(plan.temp);
  process.exit(status ?? 0);
}

/**
 * Память проверок (9.3): зелёный итог команды на том же дереве отдаётся без
 * прогона. Только группе панели (её метка `AGENTDECK_BRIEF_OUTPUT`) или по
 * `--memo`: человек и CI гоняют всегда по-настоящему. Тесты папки e2e — мимо:
 * они идут по стенду, а стенд меняется без единой правки в файлах. Отпечаток
 * снимается ДО прогона — правка во время прогона не попадёт в память под
 * чужим отпечатком.
 */
async function checkMemoOf(project, options, plan, files) {
  const wanted = Boolean(options.memo) || (await briefMarked());
  if (!wanted || options.fresh || options.dry || plan.stand) return undefined;
  const { treeFingerprint, recall, rememberGreen, forget, replayRun } = await domain('check-memo');
  const fingerprint = treeFingerprint(project);
  if (!fingerprint) return undefined;
  // Отчёт прогона лежит в свежем временном каталоге, и его путь сидит в строке
  // (`{report}`, `{go-modules}`): ключ со случайным путём не совпадал ни разу,
  // и своя команда проекта из памяти не отвечала никогда (19.10.2026).
  const stable = plan.temp
    ? plan.line.replaceAll(plan.temp, '{temp}').replaceAll(plan.temp.replace(/\\/g, '/'), '{temp}')
    : plan.line;
  const key = createHash('sha256')
    .update(`${stable}\0${plan.cwd}\0${[...files].sort().join('\0')}`)
    .digest('hex');
  return {
    hit: recall(project, key, fingerprint),
    // Ответ памяти — своей записью истории: проверка конца хода ждёт прогона после правки.
    replay(scope) {
      return this.hit ? replayRun(project, this.hit.runId, scope) : undefined;
    },
    settle(runId) {
      if (runId) rememberGreen(project, { key, fingerprint, runId, at: new Date().toISOString() });
      else forget(project, key);
    },
  };
}

/**
 * Своя команда прогона: файлы — в `{files}`/`{paths}` или в конец строки, запуск
 * из корня. `{report}` — отчёт JUnit этого прогона во временном файле (и в
 * `AGENTDECK_JUNIT_REPORT`), как у команды из automation.json: без подстановки
 * `vitest --outputFile={report}` записал отчёт в копию группы файлом с
 * буквальным именем `{report}`, а снести его агенту не дал страж rm (19.10.2026).
 */
function commandPlan(command, files, project) {
  const list = files.join(' ');
  const line = /\{files\}|\{paths\}/.test(command)
    ? command.replaceAll('{files}', list).replaceAll('{paths}', list)
    : `${command} ${list}`;
  if (!line.includes('{report}')) return { line, cwd: project, env: {}, origin: 'ci' };
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const report = join(temp, 'junit.xml');
  return {
    line: line.replaceAll('{report}', shellQuote(report)),
    cwd: project,
    env: { AGENTDECK_JUNIT_REPORT: report },
    results: ['junit', report],
    temp,
    origin: 'ci',
  };
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
    // Папка e2e идёт по стенду: его состояние в отпечаток дерева не входит (9.3).
    stand: true,
  };
}

/**
 * Своя команда проекта из `.agent/tests/automation.json` — та же, что у кнопки
 * панели: подстановки `{files}`/`{paths}`/`{packages}`/`{report}`, отчёт во временный файл через
 * `AGENTDECK_JUNIT_REPORT`. `files` — файлы кейсов с автотестом (группы, если задана), `whole` —
 * без группы: `{paths}`/`{packages}` — весь набор раннера. Сломанный файл —
 * отказ словами, а не тихий откат на npm test.
 */
const STAND_COMMAND =
  /https?:\/\/|\blocalhost\b|127\.0\.0\.1|--health\b|\bplaywright\b|\bcypress\b/i;

async function automationPlan(project, files, whole) {
  const { readAutomation, automationCommand, clearReport, collectReport, reportTail } =
    await domain('automation');
  const { automation, error } = readAutomation(project);
  if (error) throw new Error(`.agent/tests/automation.json: ${error}`);
  if (!automation) return undefined;
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const own = automationCommand(project, automation, files, join(temp, 'junit.xml'), whole);
  clearReport(own.report);
  return {
    line: own.line,
    listed: own.listed,
    cwd: own.cwd,
    env: own.env,
    collect: (started) => collectReport(own.report, own.format, started),
    tail: () => reportTail(own.report),
    reportShown: automation.report ?? own.report,
    temp,
    origin: 'e2e',
    // Своя команда, что идёт по стенду (адрес, проверка его здоровья, браузерный
    // раннер), памяти не подлежит, как папка e2e (ревью B2-F6): стенд меняется без
    // единой правки в файлах.
    stand: STAND_COMMAND.test(own.line),
    ...(automation.timeoutMinutes ? { timeout: automation.timeoutMinutes * 60_000 } : {}),
  };
}

/** Файл набора vitest/jest по имени: `*.test.ts(x)` и родня, без `*.spec` — их ведёт папка e2e. */
const VITEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/**
 * Кейсы vitest там, где своя команда проекта их не прогонит: она пишет родной
 * отчёт Go или Cargo (`{go-modules}` отдал бы `*.test.ts` в `go test` пакетом),
 * или её нет вовсе, а у корня нет scripts.test. Тогда каждый файл идёт vitest
 * ближайшего к нему package.json — так группа не собирает JUnit руками и не
 * ищет, как его импортировать (19.10.2026: пять ходов и три чтения справки).
 * Пакеты — цепочкой, как `{go-modules}`: провал одного не обрывает остальные,
 * красное видно по отчёту. classname vitest пишет от корня пакета, а кейсы
 * знают путь от корня проекта — отчёт переписывается к нему.
 */
async function vitestPlan(project, files) {
  // Кейс-набор (`file` — каталог) тоже: внутри JS-пакета, не в корне проекта.
  const vitestCase = (file) =>
    VITEST_FILE.test(file) || (file.endsWith('/') && packageRootOf(project, `${file}x`) !== '');
  if (!files.every(vitestCase)) return undefined;
  const { readAutomation } = await domain('automation');
  const { automation } = readAutomation(project);
  const native = automation?.format && automation.format !== 'junit';
  if (automation && !native) return undefined;
  if (!automation && rootTestScript(project)) return undefined;
  // Пути файлов пишет и агент (`automation.file`): та же защита от подстановок оболочки, что у `{files}`.
  const { shellArg } = await domain('e2e-command');

  const byPackage = new Map();
  for (const file of files) {
    const dir = packageRootOf(project, file);
    byPackage.set(dir, [...(byPackage.get(dir) ?? []), dir ? file.slice(dir.length + 1) : file]);
  }
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const runs = [...byPackage].sort(([a], [b]) => a.localeCompare(b));
  const parts = runs.map(([dir, inside], index) => {
    const cwd = upperDrive(join(project, dir));
    const bin = vitestEntry(cwd);
    if (!bin) {
      dropTemp(temp);
      throw new Error(
        `vitest не установлен в ${dir || '.'}, а сам он не ставится. Установите зависимости пакета и повторите.`,
      );
    }
    const report = join(temp, `vitest-${index}.xml`);
    // Из каталога пакета, а не корня проекта: `--root` не меняет process.cwd, а Babel
    // (react-compiler в vite-плагине) ищет свои плагины от cwd — из корня монорепо без
    // node_modules каждый набор падал на трансформе, «no tests» (widget-app, 20.10.2026).
    const enter = `${process.platform === 'win32' ? 'cd /d' : 'cd'} ${shellQuote(cwd)} && `;
    return (
      `${enter}${shellQuote(process.execPath)} ${shellQuote(bin)} run --root ${shellQuote(cwd)} ` +
      `--reporter=default --reporter=junit ` +
      `--outputFile.junit=${shellQuote(report)} ${inside.filter(Boolean).map(shellArg).join(' ')}`
    );
  });
  const chained = parts.length > 1;
  let missing = false;
  return {
    // Звено в скобках, как у `{go-modules}`: без них cmd пропускал всё после зелёного звена.
    line: chained ? parts.map((part) => `(${part} || echo -)`).join(' && ') : parts[0],
    cwd: project,
    env: {},
    temp,
    origin: 'ci',
    reportShown: `${temp}/vitest-*.xml`,
    // Цепочка гасит код провала (`|| echo -`): красное — из самого отчёта, и пакет
    // без отчёта (упал до тестов) тоже красный.
    failed: (content) => chained && (missing || /<(failure|error)\b/.test(content)),
    collect: (started) => {
      const bodies = [];
      for (const [index, [dir]] of runs.entries()) {
        const path = join(temp, `vitest-${index}.xml`);
        if (!freshSince(path, started)) {
          console.log(`Пакет ${dir || '.'}: vitest отчёта не записал — его кейсы не тронуты.`);
          missing = true;
          continue;
        }
        const xml = readFileSync(path, 'utf8')
          .replace(/<\?xml[^>]*\?>/g, '')
          .replace(/<\/?testsuites\b[^>]*>/g, '');
        bodies.push(dir ? rootRelativeSuites(xml, dir) : xml.trim());
      }
      if (bodies.length === 0) return undefined;
      return {
        content: `<testsuites>\n${bodies.join('\n')}\n</testsuites>\n`,
        files: bodies.length,
      };
    },
  };
}

/**
 * Буква диска — заглавная. НЕ УБИРАТЬ: `--project "d:\…"` (так путь отдаёт VS Code) давал
 * vitest каталог и входной файл с `d:`, а Vite на Windows считает `d:/…` и `D:/…` разными
 * модулями — тест получал второй экземпляр `vitest` без раннера, каждый файл падал с
 * «Vitest failed to find the runner», «no tests» (widget-app, 22.10.2026). Держит тест
 * «путь проекта со строчной буквой диска» в tests-cli.integration.test.ts.
 */
function upperDrive(path) {
  return process.platform === 'win32' ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : path;
}

/** classname и имя набора vitest — от корня пакета; кейсы знают путь от корня проекта. */
function rootRelativeSuites(xml, dir) {
  const prefix = `${dir}/`;
  return xml
    .replace(/(<testsuite\b[^>]*?\bname=")([^"]*)"/g, (all, head, name) =>
      name.startsWith(prefix) ? all : `${head}${prefix}${name}"`,
    )
    .replace(/(\bclassname=")([^"]*)"/g, (all, head, name) =>
      name.startsWith(prefix) ? all : `${head}${prefix}${name}"`,
    )
    .trim();
}

/**
 * Входной файл vitest, видимый из пакета: его bin из package.json. Не обёртка
 * `.bin/vitest.cmd` — cmd, вызвав `.cmd` без `call`, назад в цепочку не
 * возвращается, и второй пакет не запускался вовсе.
 */
function vitestEntry(cwd) {
  try {
    const manifest = createRequire(join(cwd, 'package.json')).resolve('vitest/package.json');
    const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin;
    const entry = typeof bin === 'string' ? bin : bin?.vitest;
    return entry ? join(dirname(manifest), entry) : undefined;
  } catch {
    return undefined;
  }
}

/** Каталог ближайшего к файлу package.json от корня проекта (`''` — сам корень). */
function packageRootOf(project, file) {
  const parts = file.split('/').slice(0, -1);
  for (let depth = parts.length; depth > 0; depth--) {
    const dir = parts.slice(0, depth).join('/');
    if (existsSync(join(project, dir, 'package.json'))) return dir;
  }
  return '';
}

function rootTestScript(project) {
  try {
    return Boolean(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))?.scripts?.test);
  } catch {
    return false;
  }
}

/**
 * Аргумент строки для `shell: true`: cmd — двойные кавычки при пробеле или знаке cmd; sh —
 * одинарные, в двойных он раскрывает `$` и обратные кавычки (близнец `apps/server/src/lib/shell-quote.ts`).
 */
function shellQuote(value) {
  if (process.platform === 'win32') return /[\s"'&|<>^()]/.test(value) ? `"${value}"` : value;
  return /^[\w./:@%+,=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
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
    // --group — кейсы только этой группы: ключ набора пакета двусмыслен на весь монорепозиторий.
    if (options.group && options.group !== true) await groupsOf(project, options);
    const groups = options.group && options.group !== true ? { groups: [options.group] } : {};
    return printImport(
      importResults(project, { format, file: inside, ...groups }),
      'Результаты приняты',
    );
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
