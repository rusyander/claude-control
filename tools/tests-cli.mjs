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
 *     (группы ещё нет, а другие есть — отказ с похожими; новая заводится с --new-group)
 *   node tools/tests-cli.mjs record auth:auth-001=passed auth:auth-002=failed --note "…"
 *
 * Коды возврата рассчитаны на CI: `report` отвечает 1, если есть провалённые
 * или заблокированные кейсы ВНЕ карантина, `run` — кодом самой команды прогона,
 * (124 — прогон дольше предела на кейс, `--case-timeout`), `diff` — 1 при НОВЫХ провалах (давно известная поломка не красит каждую
 * следующую сборку), `lint` — только если спросили `--fail-on <серьёзность>`.
 * Кейс в карантине печатается отдельным списком и сборку не роняет: команда уже
 * решила, что он сейчас не сторожевой.
 */
import { spawn, spawnSync } from 'node:child_process';
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
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BRAND_SLUG, LEGACY_BRAND_SLUG } from '../apps/server/src/lib/brand.mjs';
import { PROGRESS_MARK } from './qa/vitest-progress-reporter.mjs';
import { BASE_COPY_ENV, expandCopyPaths } from './tests-cli-base.mjs';
import {
  ENVIRONMENT_EXIT,
  caseCommand,
  goSumTracked,
  healthUrls,
  partSaid,
  printTree,
  runParts,
  runPartsApart,
  takeGateReports,
} from './tests-cli-parts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
/** Метки хода vitest (начало/конец файла, итог теста) — по ним видно, кто держит прогон. */
const PROGRESS_REPORTER = join(HERE, 'qa', 'vitest-progress-reporter.mjs').replaceAll('\\', '/');
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
  show      один кейс целиком: show <группа>:<кейс> или show <кейс>; --history — его исходы
            по прогонам (новые сверху) и прогоны на развилке
  sync      тесты папки e2e — в кейсы: новые заводятся, знакомым обновляется привязка
  run       прогнать автотесты кейсов и забрать результаты
  import    забрать результаты прогона или кейсы из файла
  export    выгрузить группу в csv | md | xlsx
  report    сводка по статусам; --reporter junit — XML для CI
  lint      замечания набора: дубликаты, черновики, кейсы без ожидания
  diff      что изменилось между прогонами: diff <база> <новый>
  plan      собрать план правилом: plan smoke | diff | release | flaky
  case      завести или обновить кейс (агент чата): --group <g> --json '<кейс>' | --file <f.json>
            группы нет, а другие есть — отказ с похожими; новая группа — --new-group
            кейс человека не переписывается — правка уходит черновиком на приёмку;
            правка по "id" — только названные поля, прочие (и title) остаются как были:
            метка живой проверки — case --group <g> --json '{"id":"<кейс>","tags":["live"]}'
            Кейс пишется для человека: заголовок — проверяемое поведение, шаг на поведение,
            ожидание шага — что видно (текст на экране, статус или поле ответа, содержимое
            файла, строка отчёта), а не «все проходят» / «работает» (это ловит lint, правило
            vague-case, и проверка конца хода); кейс на тест называет тест в ожидании (файл › тест)
  suites    каталоги с тестами — в кейсы-наборы (кейс на каталог, итог — худший тест); --dry — только счёт
  gate      пробелы хода агента: gate --since <ISO> [--changed-at <ISO>] <файл…>; код 1 — есть пробелы
            (его зовёт хук конца хода: правил код — кейс, прогон, запись)
  gaps      пробелы блока «Тесты» перед «доставлено» — тем же кодом, что сверка доставки:
            gaps [--since <ISO начала группы>]; без --since начало берётся из состояния панели
            по пути копии; код 1 — есть пробелы
  delivery  проба сдачи копии единицы ядра до ответа — тот же суд, что шаг публикации ядра
            (состав финальной проверки, база, конфликт, требования, сита, тексты коммитов и MR,
            открытые вопросы человеку); через панель (/api/core/delivery); код 0 — сдавать
            нечего, 1 — отказ (строки «- …»), 2 — судить нечем (панель/ядро молчат, копия не ядра)
  record    записать проверенное вручную (только ручные кейсы, в разделе — «вручную»):
            record <группа>:<кейс>=passed|failed|blocked|skipped …; автокейс — только run
  case-cmd  своя команда кейса у этой копии — один раз, дальше её берут run, --stale и --base:
            case-cmd <группа:кейс,…> --cmd "<команда>" [--format f] | case-cmd <…> --clear |
            case-cmd — список; лежит в .agent/tests/case-commands.json вне git (рецепт машины);
            --cmd в самой команде run сильнее неё
  tree      отпечаток дерева (тот же, что у run и import --tree): tree [--out <файл>] — для
            <имя>.tree рядом с отчётом ворот в .agent/tests/gate-junit/

Окружение набора: поле "env" в .agent/tests/automation.json — каталог от корня ("." — весь
проект) → { "ПЕРЕМЕННАЯ": "значение" }; кейс под каталогом получает его переменные (узкий
каталог сильнее), {copy} в значении — корень копии. Кейсы с разным окружением или своей
командой run гонит частями, каждую своим прогоном. Сборка Go, упавшая на окружении (missing
go.sum entry при go.sum вне git, go.mod/тулчейн), записывается «заблокирован» с причиной, код 75.

Опции:
  --project <dir>   каталог проекта (по умолчанию AGENTDECK_TESTS_PROJECT, иначе текущий); из
                    подкаталога — ближайший вверх с .agent/tests, не выше корня git
  --group <id>      только эта группа
  --case <g:id,…>   для run: только эти кейсы (группа:кейс через запятую; id без группы —
                    если он один такой в проекте)
  --format <f>      junit | playwright | allure | csv | xlsx | testrail-csv | testrail | allure-testops | md;
                    для run --cmd: go-test-json | cargo-test — что команда пишет в {report}
  --file <f>        файл или каталог с отчётом (путь от корня проекта)
  --tree            для import: отчёт снят на текущем дереве — его зелёный засчитается
                    кейсу другой группы с тем же автотестом (gate-run передаёт сам)
  --dir <d>        для sync: папка e2e (по умолчанию ищется сама)
  --reporter <r>    text | junit — вид отчёта команд report и diff
  --out <f>         писать результат в файл вместо экрана
  --cmd "<...>"     команда прогона (по умолчанию: кейсы папки e2e — её раннером,
                    кейсы *.test.ts(x), которые своя команда не прогонит (отчёт Go/Cargo
                    или её нет и нет scripts.test), — vitest ближайшего package.json,
                    спеки и каталоги пакета со своим playwright.config — его Playwright,
                    иначе своя команда из .agent/tests/automation.json,
                    иначе npm test из package.json); {files}/{paths} — файлы кейсов
                    (нет подстановки — в конец строки), {report} — отчёт этого прогона:
                    JUnit или вывод go test -json / cargo test (\`go test -json ./... > {report}\`;
                    вид узнаётся сам, явно — --format); {copy} — корень копии (на --base —
                    исходной: её venv и .agent/tmp в дереве развилки иначе не найти; простой
                    относительный путь к файлу копии вне git --base раскрывает в неё сам)
  --results <f>     где прогон оставит отчёт (по умолчанию ищется сам)
  --dry             для run: показать, что было бы запущено, и выйти
  --brief | --full  для run: вывод раннера — в журнал, на экран итог и первые строки падений
                    (группе панели — по умолчанию, AGENTDECK_BRIEF_OUTPUT=1) | весь, как есть
  --memo | --fresh  для run: зелёный итог на том же дереве — из памяти, без прогона (группе
                    панели — по умолчанию; e2e по стенду — всегда заново) | прогнать заново
  --base            для run: прогнать на развилке ветки с основной (временное дерево git) и
                    записать в .agent/tests/runs-base — довод воротам доставки, что красное
                    не из-за ветки (снимает только красное с той же подписью); история не трогается;
                    гоняет только красные тесты последнего прогона ветки, где раннер умеет
                    выбрать тест (pytest, go test, vitest), иначе кейс целиком; node_modules
                    пакета копии ложится ссылкой, если зависимости пакета на развилке те же
  --health [<url>]  для run: стенд, спрошенный до прогона (ответ ниже 500 — жив); не
                    ответил — прогон не запускается, кейсы ложатся «заблокирован» с причиной
                    (ворота доставки — заметка об окружении, без прогона на развилке), код 75.
                    Без адреса — адрес, куда ходит раннер (Playwright: переменная из baseURL,
                    иначе значение конфига); адрес, куда раннер не ходит, — отказ с обоими
  --stale           для run: ровно кейсы, которые gaps называет непрогнанными или устаревшими
                    (тот же расчёт, начало группы — --since или состояние панели); пробелов нет — выход 0.
                    Отчёт ворот в .agent/tests/gate-junit/<имя>.xml с <имя>.tree того же дерева
                    (tests-cli tree --out … до ворот) засчитывается без прогона
  --case-timeout <мин>  для run: предел на кейс (по умолчанию 10 мин, иначе
                    AGENTDECK_TESTS_CASE_TIMEOUT); прогон ждёт не дольше предела × число
                    файлов кейсов; у кейса с automation.timeoutMinutes (до 60) — его предел вместо
                    общего; у своей команды с timeoutMinutes — его, если флаг не назван. Дольше —
                    дерево процессов прогона снимается, кейсы ложатся в историю проваленными
                    с причиной «предел времени», код 124
  --env <id>        для run: окружение стенда из .agent/tests/environments.json — его адрес
                    (E2E_BASE_URL) и доступы из хранилища панели уходят переменными в процесс
                    прогона; прогон пишется в историю с этим окружением. Записанные проходы
                    (*.recorded.mjs) идут запускателем junit-run над проектом
  --max-failures <n>  для run: после n проваленных тестов остальные файлы не запускаются
                    («не запускался»); повтор записанных проходов встаёт на первом расхождении
  --fail-on <s>     для lint: ронять сборку с этой серьёзности (error | warning | info)
  --budget <мин>    для plan: сколько минут отведено (у «дыма» по умолчанию 30)
  --release <веха>  для plan release: чью веху собирать
  --threshold <ч>   для plan flaky: порог стабильности, доля 0–1 или проценты
  --save            для plan: записать план в проект, а не только показать
  --json '<кейс>'   для case: кейс JSON-объектом (title, steps, expected, codePaths, automation,
                    tags, id — для правки); tags — метки: живую проверку ситам доказывает
                    прошедший кейс с меткой live / stand / route / browser / e2e / db (какая
                    нужна — в строке отказа сита)
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

  const project = projectRoot(
    resolve(options.project ?? (await projectFromEnv()) ?? process.cwd()),
  );
  if (!existsSync(project)) throw new Error(`Каталог проекта не найден: ${project}`);

  if (command === 'list') return await listCases(project, options);
  if (command === 'show') return await showCase(project, positional[0], options);
  if (command === 'run' && options.stale) {
    if (options.case || options.base)
      throw new Error('--stale сам выбирает кейсы: без --case и без --base.');
    let keys = await staleKeys(project, options);
    // Ворота уже прогнали эти тесты на этом же дереве (F2) — их отчёт, а не второй прогон.
    if (keys.length > 0 && (await takeGateReports(REPO, project, keys)) > 0)
      keys = await staleKeys(project, options);
    if (keys.length === 0) {
      console.log('Блок «Тесты»: прогонять нечего — пробелов, которые снимает прогон, нет.');
      return;
    }
    console.log(`Кейсы из пробелов gaps (${keys.length}): ${keys.join(',')}`);
    options.case = keys.join(',');
  }
  if (command === 'run' && options.base) {
    const { runOnBase } = await import('./tests-cli-base.mjs');
    return await runOnBase(project, {
      repo: REPO,
      self: fileURLToPath(import.meta.url),
      argv: process.argv.slice(2),
    });
  }
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
  if (command === 'gaps') return await deliveryGaps(project, options);
  if (command === 'delivery') {
    const { deliveryCheck } = await import('./tests-cli-delivery.mjs');
    return await deliveryCheck(project, options, { repo: REPO });
  }
  if (command === 'suites') return await syncSuiteCases(project, options);
  if (command === 'tree') return await printTree(REPO, project, options);
  if (command === 'case-cmd')
    return await caseCommand(
      REPO,
      project,
      options,
      positional[0] === undefined
        ? undefined
        : [...pickedCases(await groupsOf(project, {}), positional[0])],
    );
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
    'base',
    'stale',
    'tree',
    'new-group',
    'clear',
    'history',
  ]);
  // Опция с необязательным значением: `--health` без адреса — адрес, куда ходит раннер.
  const OPTIONAL_VALUE = new Set(['health']);
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
      if (OPTIONAL_VALUE.has(name) && (next === undefined || next.startsWith('--'))) {
        options[name] = true;
        continue;
      }
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
  // Опечатка в имени группы тихо заводила новую (g8 26.10: `--group delivery` рядом с `groups`):
  // в проекте, где группы уже есть, новая заводится только явным --new-group.
  const { listGroupIds } = await domain('group-files');
  const known = listGroupIds(project);
  if (known.length > 0 && !known.includes(group) && !options['new-group']) {
    const wanted = group.toLowerCase();
    const likeness = (id) => {
      const name = id.toLowerCase();
      if (name.includes(wanted) || wanted.includes(name)) return 100;
      let shared = 0;
      while (shared < name.length && name[shared] === wanted[shared]) shared += 1;
      return shared;
    };
    const near = known
      .map((id) => ({ id, score: likeness(id) }))
      .filter((item) => item.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((item) => item.id);
    const hint = near.length
      ? `похожие: ${near.join(', ')}`
      : `есть: ${known.slice(0, 12).join(', ')}${known.length > 12 ? ', …' : ''}`;
    throw new Error(
      `Группы «${group}» в проекте нет (${hint}). Кейс не записан. Новая группа — повторите с --new-group`,
    );
  }
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
    // Приёмка черновика архив не переносит (поле жизни кейса человека): сказать, а не потерять молча.
    if (typeof input.archived === 'boolean') {
      console.log(
        `Архив кейса человека черновик не меняет: ${input.archived ? 'увести в архив' : 'вернуть из архива'} ${group}:${result.caseId} может только человек в разделе «Тесты».`,
      );
    }
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
  const { currentStamps } = await domain('content-stamp');
  const { casesTouching } = await domain('impact');
  const paths = positional.map((file) => toProjectRelative(project, file));
  const groups = readGroups(project);
  const runs = readRuns(project);
  // Отпечатки задетых кейсов сейчас: прогон с тем же отпечатком свеж, правка
  // непокрытого файла после него его не старит (`content-stamp`).
  const touched = casesTouching(paths, groups).cases.map(
    (item) => `${item.groupId}:${item.caseId}`,
  );
  const judge = (redExempt) =>
    judgeTurn({
      groups,
      runs,
      stamps: currentStamps(project, groups, runs, touched),
      paths,
      untracked: untrackedOf(project, paths),
      since,
      ...(typeof options['changed-at'] === 'string' ? { changedAt: options['changed-at'] } : {}),
      ...(options['defer-runs'] ? { deferRuns: true } : {}),
      ...(redExempt ? { redExempt } : {}),
      cli: `node "${fileURLToPath(import.meta.url)}"`,
      root: project,
    });
  let gaps = judge();
  // Ход группы: красное, которое её доставка пишет заметкой (было до старта слово
  // в слово или от окружения), ход не держит — тем же `redNotFromBranch` по диффу
  // всей ветки (g3 25.10: набор с красным с основной дважды остановил конец хода).
  // Дорогая сверка — только когда красное есть.
  const groupStart = options['defer-runs'] ? groupStartOf(project) : undefined;
  if (groupStart && gaps.some((gap) => gap.startsWith('Tests block: red this turn'))) {
    const { testsDeliveryGaps } = await import(
      pathToFileURL(
        join(REPO, 'apps', 'server', 'src', 'domains', 'chat', 'tests-gate', 'tests-gate.ts'),
      ).href
    );
    const verdict = await testsDeliveryGaps({
      cwd: project,
      startedAt: groupStart,
      command: `node "${fileURLToPath(import.meta.url)}" run --project .`,
    });
    if (verdict.notedKeys?.length) gaps = judge(new Set(verdict.notedKeys));
  }
  for (const gap of gaps) console.log(gap);
  if (gaps.length > 0) process.exitCode = 1;
}

/**
 * Пробелы блока «Тесты» перед «доставлено» — тем же `testsDeliveryGaps`, что и
 * `delivery`: группа видит весь список до сдачи, а не по кругу напоминаний. После rebase
 * задетых кейсов стало 27, а напоминание называло два — каждый такой круг стоил
 * группе хода, перепроверки и нового напоминания (24.10.2026).
 */
async function deliveryGaps(project, options) {
  const { since, verdict } = await gapsVerdict(project, options);
  if (!since)
    console.log(
      'Начало группы не найдено (дайте --since <ISO>): сверка берёт все прогоны, панель может назвать больше.',
    );
  if (verdict.unchecked) console.log(`Блок не сверен: ${verdict.unchecked}`);
  for (const line of verdict.missing) console.log(`- ${line}`);
  for (const line of verdict.notes ?? []) console.log(`заметка (в описание MR): ${line}`);
  if (verdict.runKeys?.length)
    console.log(
      `Прогнать ровно эти кейсы (${verdict.runKeys.length}): node "${fileURLToPath(import.meta.url)}" run --project . --stale` +
        (typeof options.since === 'string' ? ` --since ${options.since}` : ''),
    );
  if (verdict.missing.length > 0) process.exitCode = 1;
  else console.log('Блок «Тесты»: пробелов перед сдачей нет.');
}

/** Вердикт `gaps` — один на `gaps` и `run --stale`: тот же `testsDeliveryGaps`, что у `delivery`. */
async function gapsVerdict(project, options) {
  const since = typeof options.since === 'string' ? options.since : groupStartOf(project);
  const { testsDeliveryGaps } = await import(
    pathToFileURL(
      join(REPO, 'apps', 'server', 'src', 'domains', 'chat', 'tests-gate', 'tests-gate.ts'),
    ).href
  );
  const verdict = await testsDeliveryGaps({
    cwd: project,
    ...(since ? { startedAt: since } : {}),
    command: `node "${fileURLToPath(import.meta.url)}" run --project .`,
  });
  return { since, verdict };
}

/**
 * `run --stale` (P2, g5 25.10): ровно те кейсы, чьи пробелы `gaps` снимает прогоном — нет
 * прогона, устарел, не исполнен. Группа писала `node -e`, чтобы выбрать их из вывода.
 */
async function staleKeys(project, options) {
  return (await gapsVerdict(project, options)).verdict.runKeys ?? [];
}

/** Начало группы разделения, чья копия — `project`: из состояния панели (каталог настроек CLI). */
function groupStartOf(project) {
  const same = (path) =>
    resolve(String(path ?? ''))
      .replaceAll('\\', '/')
      .toLowerCase();
  const want = same(project);
  const roots = [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')].filter(Boolean);
  for (const root of roots)
    for (const name of [BRAND_SLUG, LEGACY_BRAND_SLUG]) {
      let state;
      try {
        state = JSON.parse(readFileSync(join(root, name, 'state.json'), 'utf8'));
      } catch {
        continue;
      }
      for (const plan of Object.values(state?.splitPlans ?? {}))
        for (const group of plan?.groups ?? [])
          if (group?.path && same(group.path) === want && group.startedAt) return group.startedAt;
    }
  return undefined;
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

async function showCase(project, caseId, options = {}) {
  if (!caseId) throw new Error('Нужен идентификатор кейса: show <группа>:<кейс> или show <кейс>');
  const { readGroups } = await domain('store');
  const { stepText } = await import(
    pathToFileURL(join(REPO, 'packages', 'contracts', 'src', 'test-format.ts')).href
  );
  // `группа:кейс` — форма, которую печатают run, gaps и ворота и требует `run --case`;
  // show знал только голый id, и скопированное из вывода «в проекте нет» (g0 25.10).
  const split = caseId.indexOf(':');
  const groupId = split > 0 ? caseId.slice(0, split) : undefined;
  const id = split > 0 ? caseId.slice(split + 1) : caseId;

  for (const group of readGroups(project)) {
    if (groupId && group.id !== groupId) continue;
    const item = group.cases.find((entry) => entry.id === id);
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
      // Своя команда копии (F3) — видна там же, где файл: иначе её помнит только блокнот группы.
      const { readCaseCommands } = await domain('case-commands');
      const own = readCaseCommands(project).commands[`${group.id}:${item.id}`];
      if (own)
        console.log(
          `Своя команда копии: ${own.cmd}${own.format ? ` (--format ${own.format})` : ''} — tests-cli case-cmd`,
        );
    }
    // Метки решают, живая ли проверка для сит (`liveTags`): без них группа читала файл кейса скриптом.
    if (item.tags?.length) console.log(`Метки: ${item.tags.join(', ')}`);
    if (item.codePaths?.length) console.log(`Код: ${item.codePaths.join(', ')}`);
    if (item.steps.length > 0) {
      console.log('\nШаги:');
      item.steps.forEach((step, index) => console.log(`  ${index + 1}. ${stepText(step)}`));
    }
    if (item.expected) console.log(`\nОжидание: ${item.expected}`);
    if (item.note) console.log(`Заметка последнего прогона: ${item.note}`);
    if (item.failure) console.log(`Провал: ${failureText(item.failure)}`);
    if (options.history) await printCaseHistory(project, group.id, item.id);
    return;
  }
  throw new Error(`Кейса «${caseId}» в проекте нет.`);
}

const HISTORY_RUNS = 50;
const HISTORY_ROWS = 15;

/**
 * История кейса по записанным прогонам — тот же расчёт, что карточка кейса в панели
 * (`case-history`). Аудит g9 27.10 (R8): без неё группа разбирала `.agent/tests/runs/*.json`
 * скриптом — сначала python3 (заглушка Store), потом `node -e`. Прогоны на развилке
 * (`run --base`) история кейса не берёт — они отдельным списком: ими ворота доставки
 * доказывают «красное не из-за ветки».
 */
async function printCaseHistory(project, groupId, caseId) {
  const { readRuns, readBaseRuns } = await domain('runs-store');
  const { caseHistory } = await domain('case-history');
  const own = caseHistory(readRuns(project, HISTORY_RUNS), groupId, caseId);
  const base = caseHistory(readBaseRuns(project), groupId, caseId);
  const line = (entry) => {
    const where = [entry.branch, entry.commit?.slice(0, 9)].filter(Boolean).join('@');
    const why = entry.failure ? failureText(entry.failure, true) : entry.note;
    return (
      `  ${STATUS_MARK[entry.status] ?? '.'} ${entry.startedAt} прогон ${entry.runId.slice(0, 8)} ` +
      `${entry.status}${where ? ` ${where}` : ''}${why ? ` — ${why}` : ''}`
    );
  };
  const shown = own.entries.slice(0, HISTORY_ROWS);
  console.log(
    `\nИстория (новые сверху; из последних ${HISTORY_RUNS} прогонов кейс есть в ${own.entries.length}` +
      `${own.entries.length > shown.length ? `, показаны ${shown.length}` : ''}):`,
  );
  if (shown.length === 0) console.log('  кейс не попадал ни в один прогон');
  shown.forEach((entry) => console.log(line(entry)));
  if (own.flaky.isFlaky) {
    console.log(`  нестабилен: ${own.flaky.flips} смен исхода за ${own.flaky.runs} прогонов`);
  }
  if (base.entries.length > 0) {
    console.log('\nПрогоны на развилке (run --base):');
    base.entries.forEach((entry) => console.log(line(entry)));
  }
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
/**
 * Каталог проекта — ближайший вверх, где есть `.agent/tests`, но не выше корня git
 * (копия в `.claude/worktrees` основной не берёт её кейсы). g0 26.10: после `cd inst-api`
 * `delivery --project . --answer .agent/tmp/…` искал ответ в `inst-api/.agent/tmp` и упал.
 * Нигде нет — каталог как сказан (новый проект `case` заводит в нём).
 */
function projectRoot(dir) {
  for (let at = dir; ;) {
    if (existsSync(join(at, '.agent', 'tests'))) return at;
    const up = dirname(at);
    if (existsSync(join(at, '.git')) || up === at) return dir;
    at = up;
  }
}

/**
 * Проект группы Claude без `--project` (X1): панель кладёт его в окружение прогона,
 * а строка о тестах в системном промпте группы идёт без путей — так копии одной
 * группы делят кэш начала запроса. Имя — из контрактов, как у метки выше.
 */
async function projectFromEnv() {
  const { TESTS_PROJECT_ENV } = await import(
    pathToFileURL(join(REPO, 'packages', 'contracts', 'src', 'chat-group-settings.ts')).href
  );
  return process.env[TESTS_PROJECT_ENV]?.trim() || undefined;
}

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

/**
 * `red` — итог прогона, а не код оболочки: цепочка пакетов (`… || echo -`) гасит код
 * провала, и прогон с 19 упавшими тестами печатал «кодом 0» без единой строки падений
 * (группа 23.10.2026) — красное агент искал руками.
 */
function briefOutput(result, red = result.status !== 0) {
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
  const failures = red
    ? lines.filter((line) => FAILURE_LINE.test(line)).slice(0, BRIEF_FAILURES)
    : [];
  return [
    ...(failures.length > 0
      ? ['Первые строки падений:', ...failures.map((line) => `  ${line.trim().slice(0, 300)}`)]
      : []),
    `Полный вывод (${lines.length} строк): ${log}`,
  ].join('\n');
}

/**
 * Синхронная блокировка теста. Предел vitest (`testTimeout`) — гонка обещаний: тест,
 * занявший поток синхронным вызовом, он не прерывает — тест идёт сколько идёт, а потом
 * получает «Test timed out in N ms». Признак — снят по пределу И шёл не меньше двух
 * пределов: асинхронный зависший тест vitest обрывает ровно на пределе (23.10.2026:
 * `cpSync` через junction, 19 тестов по 52–114 с при пределе 20 с, файл — 42 мин).
 */
const SYNC_BLOCK_FACTOR = 2;
const TIMED_OUT_TEXT = /(?:Test|Hook) timed out in (\d+)\s*ms/g;
const FAILED_TEST_LINE = /^\s*(?:×|✗)\s+(.+?)\s+(\d+)\s*ms\s*$/;

const isSyncBlock = (ms, limit) =>
  Number.isFinite(ms) && Number.isFinite(limit) && limit > 0 && ms >= SYNC_BLOCK_FACTOR * limit;

/** Тот же признак по обычному выводу vitest — у своей команды проекта меток хода нет. */
function syncBlockFromText(text) {
  const limits = [...String(text).matchAll(TIMED_OUT_TEXT)].map((found) => Number(found[1]));
  if (limits.length === 0) return undefined;
  // Самый длинный из пределов: при двух проектах с разными пределами — без ложной тревоги.
  const limit = Math.max(...limits);
  for (const line of String(text).split(/\r?\n/)) {
    const found = FAILED_TEST_LINE.exec(line);
    if (found && isSyncBlock(Number(found[2]), limit))
      return { where: found[1].trim(), ms: Number(found[2]), limit };
  }
  return undefined;
}

const secs = (ms) => Math.round(ms / 1000);

function syncBlockLine(block) {
  return (
    `Синхронная блокировка: ${block.where} шёл ${secs(block.ms)} с при пределе ` +
    `${secs(block.limit)} с — vitest не прерывает синхронный код: тест или его оснастка ` +
    `держит поток синхронным вызовом (cpSync/rmSync/spawnSync/execSync по большому дереву, ` +
    `Atomics.wait). Повтор прогона и больший testTimeout не помогут — ищи этот вызов в файле ` +
    `и его фикстурах.`
  );
}

/**
 * Ручной прогон под `timeout N` после снятого прогона стоил группе 24.10.2026 три прогона
 * по 4 мин: снятый сроком обёртки воркер печатает «Worker exited unexpectedly», а
 * обвязка проекта называла это нехваткой ресурсов — агент мерил свободную память.
 */
const WRAP_TIP =
  'Файл напрямую не гоняй и не оборачивай vitest в `timeout N`: воркер, снятый сроком ' +
  'обёртки, печатает «Worker exited unexpectedly» — это срок обёртки, а не нехватка ресурсов. ' +
  'Повтор — тем же `tests-cli run`, предел — `--case-timeout`.';

/** Путь файла набора от корня проекта (метки vitest несут абсолютный). */
function projectRelative(project, file) {
  const root = upperDrive(project).replaceAll('\\', '/').replace(/\/$/, '');
  const path = upperDrive(String(file)).replaceAll('\\', '/');
  return path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? path.slice(root.length + 1)
    : path;
}

/** Ход прогона по меткам `vitest-progress-reporter`: какие файлы начаты, какие закончены. */
function newProgress() {
  const files = new Map();
  return {
    files,
    see(event) {
      const now = Date.now();
      const entry = files.get(event.file) ?? { started: now, last: undefined, ended: false };
      if (event.e === 'start') entry.started = now;
      else if (event.e === 'end') entry.ended = true;
      else entry.last = now;
      files.set(event.file, entry);
    },
  };
}

function progressEvent(line) {
  const at = line.indexOf(PROGRESS_MARK);
  if (at === -1) return undefined;
  try {
    const event = JSON.parse(line.slice(at + PROGRESS_MARK.length).trim());
    return event && typeof event.e === 'string' ? event : undefined;
  } catch {
    return undefined;
  }
}

/** Незаконченные к остановке файлы — по одному в строке, с тем, сколько они молчат. */
function unfinishedLines(project, progress) {
  if (!progress) return [];
  const now = Date.now();
  return [...progress.files]
    .filter(([, entry]) => !entry.ended)
    .slice(0, 10)
    .map(
      ([file, entry]) =>
        `Не закончили к остановке: ${projectRelative(project, file)} — начат ${secs(now - entry.started)} с назад, ` +
        (entry.last === undefined
          ? 'итога ни одного теста так и не пришло'
          : `последний итог теста ${secs(now - entry.last)} с назад`),
    );
}

/** Счёт отчёта JUnit: сколько тестов упало, прошло, пропущено. */
function junitCounts(xml) {
  const counts = { failed: 0, passed: 0, skipped: 0 };
  for (const found of String(xml).matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = found[1] ?? '';
    if (/<(failure|error)\b/.test(body)) counts.failed++;
    else if (/<skipped\b/.test(body)) counts.skipped++;
    else counts.passed++;
  }
  return counts;
}

/** Красное по отчётам звеньев цепочки, когда её код погашен `|| echo -`. */
function reportRed(plan, started) {
  if (!plan.failed || !plan.collect) return false;
  try {
    return plan.failed(plan.collect(started, { quiet: true })?.content ?? '');
  } catch {
    return false;
  }
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

  // Своя команда кейса у копии и окружение набора (F3, M2): разные — частями, каждая своим run.
  const parts = await runParts(REPO, project, automated, options);
  if (parts.length > 1)
    process.exit(
      runPartsApart(project, parts, {
        argv: process.argv.slice(2),
        self: fileURLToPath(import.meta.url),
      }),
    );
  const [part] = parts;
  if (part.cmd) {
    options.cmd = part.cmd;
    if (part.format && typeof options.format !== 'string') options.format = part.format;
  }
  const said = partSaid(part);
  if (said) console.log(`Кейсы несут своё: ${said}`);

  const files = [...new Set(automated.map((entry) => entry.item.automation.file))];
  // Без --cmd тесты папки e2e идут той же командой, что у кнопки панели: из
  // каталога её конфига, раннером папки, с отчётом во временный файл. Запуск
  // из корня брал чужую версию Playwright и не находил тестов. Не папка —
  // своя команда проекта из automation.json (её же зовёт кнопка), и только
  // потом npm test.
  const plan = options.cmd
    ? commandPlan(options.cmd, files, project)
    : (recordedPlan(project, files) ??
      (await e2ePlan(project, files)) ??
      (await vitestPlan(project, files)) ??
      (await mixedPlan(project, files, !options.group && !picked)) ??
      (await automationPlan(project, files, !options.group && !picked)) ??
      commandPlan(projectTestCommand(project), files, project));
  if (options.cmd && NATIVE_REPORTS.has(options.format) && !plan.ownReport)
    throw new Error(
      `--format ${options.format} у --cmd читает отчёт из {report}: добавьте его в команду ` +
        `(\`go test -json ./... > {report}\`, \`cargo test > {report} 2>&1\`).`,
    );
  if (options.cmd) warnFailFast(project, options.cmd, automated);
  // Окружение набора — под переменные самого плана: путь отчёта раннера рецептом не перебить.
  if (Object.keys(part.env).length) {
    plan.env = { ...part.env, ...plan.env };
    plan.envKey = part.id;
  }
  // Выбор (`--case`, `--group`) доходит до `junit-run.mjs`: скрипт с кейсами на разные аргументы
  // гоняет только выбранные, а не все кейсы своего файла (прогон 3deb1cb9 упёрся в предел так).
  // Список длиннее предела переменной Windows (32 767) не передаётся — тогда гоняется весь файл.
  const pickedList = automated.map((entry) => `${entry.group}:${entry.item.id}`).join(',');
  if ((picked || options.group) && pickedList.length < 30_000)
    plan.env = { ...plan.env, AGENTDECK_TEST_CASES: pickedList };
  // Окружение стенда (`--env`): адрес и доступы — переменными процесса прогона, как у кнопки панели.
  if (options.env) plan.env = { ...plan.env, ...(await standRunEnv(project, options.env)) };
  // Лежащий стенд у записанного прохода — «не засчитано», а не расхождение на первом шаге.
  if (plan.recorded && plan.env.E2E_BASE_URL && !plan.env.JUNIT_RUN_HEALTH)
    plan.env = { ...plan.env, JUNIT_RUN_HEALTH: plan.env.E2E_BASE_URL };
  if (options['max-failures'] !== undefined) {
    const limit = numberOption(options['max-failures'], '--max-failures', 'целое больше нуля');
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error(
        `--max-failures ждёт целое больше нуля, а пришло «${options['max-failures']}».`,
      );
    plan.env = { ...plan.env, JUNIT_RUN_MAX_FAILURES: String(options['max-failures']) };
  }
  await narrowToBranchRed(project, plan, automated);

  console.log(`Кейсов с автотестом: ${automated.length}, файлов: ${files.length}`);
  console.log(`Команда: ${plan.line}`);
  // Список длиннее строки cmd.exe ушёл файлом — иначе по строке выглядит, будто гонится всё.
  if (plan.listed) console.log(`Файлов прогона: ${plan.listed} — списком в AGENTDECK_TEST_FILES`);
  let cap;
  try {
    cap = runCap(options, files.length, plan.timeout, ownCaseLimits(automated));
  } catch (error) {
    dropTemp(plan.temp);
    throw error;
  }
  console.log(`Предел: ${cap.shown}`);
  // Стенд — тот, куда ходит раннер (M3): чужой адрес — отказ до прогона и до записи.
  let stand;
  if (options.health) {
    try {
      stand = await healthUrls(REPO, plan, options.health, { ...process.env, ...plan.env });
    } catch (error) {
      dropTemp(plan.temp);
      throw error;
    }
    console.log(`Стенд: ${stand.said}`);
  }
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

  // Отпечаток содержимого кейсов — ДО прогона: по нему ворота доставки и конца
  // хода судят свежесть записи, и коммит после прогона её не старит, а правка
  // во время прогона — старит (`content-stamp`).
  const { contentStamps, stampInputs } = await domain('content-stamp');
  const stamps = contentStamps(
    project,
    stampInputs(groups, new Set(automated.map(({ group, item }) => `${group}:${item.id}`))),
  );
  // Отпечаток всего дерева — тоже до прогона (T2, g5 25.10): зелёный автотест на этом
  // дереве ворота засчитают и кейсу другой группы с тем же automation.
  const tree = (await domain('check-memo')).treeFingerprint(project);
  const down = [];
  for (const url of stand?.urls ?? []) if (!(await standAnswers(url))) down.push(url);
  if (down.length) {
    await recordStandDown(project, { plan, automated, picked, options, stamps, down });
    printSkipped(skipped);
    dropTemp(plan.temp);
    memo?.settle(undefined);
    process.exit(STAND_DOWN_EXIT);
  }
  const started = Date.now();
  const brief = !options.full && (Boolean(options.brief) || (await briefMarked()));
  const result = await runPlan(plan, brief, cap.ms);
  const stopped = result.timedOut || Boolean(result.syncBlock);
  const masked = !stopped && result.status === 0 && reportRed(plan, started);
  if (brief) console.log(briefOutput(result, result.status !== 0 || masked));
  const syncBlock =
    result.syncBlock ??
    (brief ? syncBlockFromText(`${result.stdout ?? ''}${result.stderr ?? ''}`) : undefined);
  const unfinished = stopped ? unfinishedLines(project, result.progress) : [];
  for (const line of [
    ...(syncBlock ? [syncBlockLine(syncBlock)] : []),
    ...unfinished,
    ...(stopped || syncBlock ? [WRAP_TIP] : []),
  ])
    console.log(line);
  const exitCode = result.status ?? undefined;
  console.log(
    `\nКоманда завершилась с кодом ${exitCode ?? 'нет кода'} за ${Math.round((Date.now() - started) / 1000)} с` +
      (masked ? ' (код звеньев погашен цепочкой; по отчёту — красный)' : ''),
  );
  if (stopped) {
    await recordTimeout(project, {
      plan,
      automated,
      cap,
      started,
      picked,
      options,
      stamps,
      syncBlock: result.syncBlock,
      unfinished: [...(result.progress?.files ?? [])]
        .filter(([, entry]) => !entry.ended)
        .map(([name]) => projectRelative(project, name)),
    });
    printSkipped(skipped);
    dropTemp(plan.temp);
    memo?.settle(undefined);
    process.exit(TIMEOUT_EXIT);
  }

  // `--cmd … > {report}` с выводом go test -json / cargo test — сбор своей команды ниже.
  const native = plan.ownReport && nativeFormatOf(plan.ownReport, options.format);
  if (native) {
    const { collectReport, reportTail } = await domain('automation');
    plan.collect = (since) => collectReport(plan.ownReport, native, since);
    plan.tail = () => reportTail(plan.ownReport);
    plan.reportShown = plan.ownReport;
  }

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
    if (process.env[BASE_COPY_ENV])
      console.log(
        'Команда шла в дереве развилки: файлов копии вне git (.agent/tmp, venv, .env) там нет — ' +
          `путь к ним в --cmd пишется через {copy} (здесь ${process.env[BASE_COPY_ENV]}).`,
      );
    printSkipped(skipped);
    dropTemp(plan.temp);
    process.exit(result.status || 1);
  }

  let content = plan.temp ? readFileSync(path, 'utf8') : undefined;
  // Сборка, упавшая на окружении (M2: missing go.sum entry без рецепта), — «заблокирован»
  // с причиной, а не красное кейса: код ветки до тестов не дошёл.
  let environment;
  if (format === 'junit' && statSync(path).isFile()) {
    const { blockEnvironmentFailures } = await domain('env-failure');
    const verdict = blockEnvironmentFailures(
      content ?? readFileSync(path, 'utf8'),
      goSumTracked(project),
    );
    if (verdict.blocked.length) {
      content = verdict.content;
      environment = verdict;
    }
  }
  // Цепочка пакетов гасит код провала — красное из самого отчёта, и в историю тоже.
  const failedByReport = plan.failed?.(content) ? 1 : result.status;
  const status = environment && !environment.red ? ENVIRONMENT_EXIT : failedByReport;
  const { importResults } = await domain('import-results');
  const imported = importResults(project, {
    format,
    ...(content !== undefined ? { content } : { file: toProjectRelative(project, file) }),
    origin: plan.origin,
    scope: `tests-cli run: ${plan.line}`,
    ...(options.env ? { environmentId: options.env } : {}),
    exitCode: status ?? exitCode,
    // Прогон части (--group, --case) — результаты на кейсы этих групп: одинаковый
    // ключ набора двух пакетов на весь проект двусмыслен, и его результат терялся.
    ...(options.group || picked ? { groups: [...new Set(automated.map((e) => e.group))] } : {}),
    stamps,
    ...(tree ? { tree } : {}),
  });
  printImport(
    imported,
    `Импортировано из ${plan.temp ? 'отчёта прогона' : file} (${format})`,
    format === 'junit' ? (content ?? readFileSync(path, 'utf8')) : undefined,
  );
  if (environment)
    console.log(
      `\nПровал окружения, не кода (${environment.blocked.length}) — записан «заблокирован» с причиной: ` +
        `${environment.blocked.slice(0, 8).join(', ')}${environment.blocked.length > 8 ? ' …' : ''}. ` +
        'Рецепт окружения набора (GOFLAGS и т. п.) — поле "env" в .agent/tests/automation.json.',
    );
  // Кейс, которого отчёт не назвал, не проверен, а не зелёный: 25.10 группа
  // просила два кейса, своя команда проекта потеряла путь одного, обновился один —
  // и код 0 читался как «оба прошли».
  const missing = await missingResults(project, imported.runId, automated);
  if (missing.length) {
    console.log(
      `\nБез результата в этом прогоне (${missing.length}) — команда их не исполнила, кейс не проверен:`,
    );
    for (const line of missing) console.log(`    ✗ ${line}`);
  }
  const code = status === 0 && missing.length ? 1 : status;
  memo?.settle(code === 0 && imported.read > 0 ? imported.runId : undefined);
  printSkipped(skipped);
  dropTemp(plan.temp);
  process.exit(code ?? 0);
}

/**
 * Флаг «стоп на первом падении» в `--cmd` у кейса-каталога (g0 25.10, F-03): `pytest -x`
 * встал на первом красном, набор каталога получил часть тестов, и записать его итогом
 * всего каталога было нельзя — ход ушёл впустую. Предупреждение до прогона, не отказ.
 */
const FAIL_FAST =
  /(?:^|\s)(-x|--exitfirst|--bail(?:=\S+)?|-{1,2}failfast|--maxfail(?:=|\s+)1)(?=\s|$)/;

function warnFailFast(project, cmd, automated) {
  const flag = cmd.match(FAIL_FAST)?.[1];
  if (!flag) return;
  const isDir = ({ item }) => {
    const file = item.automation.file;
    if (file.endsWith('/') || item.automation.suite) return true;
    try {
      return statSync(join(project, file)).isDirectory();
    } catch {
      return false;
    }
  };
  const dirs = automated.filter(isDir).map(({ group, item }) => `${group}:${item.id}`);
  if (dirs.length === 0) return;
  console.log(
    `Внимание: в --cmd флаг «${flag}» — раннер встанет на первом падении, и кейс-каталог ` +
      `${dirs.slice(0, 5).join(', ')}${dirs.length > 5 ? ` (+${dirs.length - 5})` : ''} получит только ` +
      'часть своих тестов: итогом всего каталога его не записать. Уберите флаг; «моё ли красное» — ' +
      '`run --case … --base`, он гоняет на развилке только красные тесты ветки.',
  );
}

/**
 * Дочерний прогон `run --base` (F-03): строка сужается до красных тестов ветки, когда раннер
 * умеет выбрать тест (`red-filter`); иначе кейсы идут целиком — с причиной в выводе.
 */
async function narrowToBranchRed(project, plan, automated) {
  const { BASE_RED_ENV, narrowToRed } = await domain('red-filter');
  const file = process.env[BASE_RED_ENV];
  if (!file) return;
  // Команде раннера переменная не нужна.
  delete process.env[BASE_RED_ENV];
  let reds = {};
  try {
    reds = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // список не прочитан — кейсы идут целиком, как без него
  }
  const cases = automated.map(({ group, item }) => ({
    key: `${group}:${item.id}`,
    file: item.automation.file,
    tests: reds[`${group}:${item.id}`],
  }));
  const narrowed = narrowToRed(plan.line, cases, (path) => existsSync(join(plan.cwd, path)));
  if ('reason' in narrowed) {
    console.log(`На развилке — кейсы целиком: ${narrowed.reason}.`);
    return;
  }
  plan.line = narrowed.line;
  console.log(
    `На развилке — только красные тесты ветки (${narrowed.runner}): ${narrowed.tests}. ` +
      'Подпись красного сверяется без общего счёта, суженный прогон даёт ту же.',
  );
}

/** Запрошенные кейсы с автотестом, которых нет в результатах записанного прогона. */
async function missingResults(project, runId, automated) {
  const { readRun } = await domain('runs-store');
  const record = runId ? readRun(project, runId) : undefined;
  const seen = new Set((record?.results ?? []).map((entry) => `${entry.groupId}:${entry.caseId}`));
  return automated
    .filter(({ group, item }) => !seen.has(`${group}:${item.id}`))
    .map(({ group, item }) => {
      const { file, testName } = item.automation;
      return `${group}:${item.id} — ${file}${testName ? ` › ${testName}` : ''}`;
    });
}

/**
 * Предел прогона на кейс (N2, журнал групп 23.10): повисший кейс держал группу
 * часами — `run` ждал команду без срока, а `timeoutMinutes` есть только у своей
 * команды проекта. Предел — на файл кейса (кейсы одного файла гоняются одним
 * прогоном), команда целиком ждёт предел × число файлов. `timeoutMinutes`
 * своей команды — её собственный предел, и он сильнее произведения в обе
 * стороны (F-58): своя команда часто гонит весь набор, и 10 мин × 1 файл
 * снимали здоровый получасовой прогон. Сильнее него — только `--case-timeout`,
 * названный в этой самой команде.
 */
const CASE_TIMEOUT_ENV = 'AGENTDECK_TESTS_CASE_TIMEOUT';
const CASE_TIMEOUT_DEFAULT_MIN = 10;
/** Код выхода прогона, снятого по пределу, — как у `timeout` из coreutils. */
const TIMEOUT_EXIT = 124;
/**
 * Дольше `setTimeout` не умеет: больше 2^31−1 мс он срабатывает через 1 мс
 * (F-59) — `--case-timeout 40000` снимал здоровый прогон сразу, кодом 124.
 */
const TIMER_MAX_MS = 2 ** 31 - 1;
/** Сколько дочитывать вывод после выхода команды, если трубу держит её фоновый внук. */
const DRAIN_MS = 2_000;
/** Сколько ждать выхода после SIGTERM дерева по пределу, прежде чем SIGKILL корня. */
const KILL_GRACE_MS = 5_000;

/**
 * Свои пределы кейсов прогона (`automation.timeoutMinutes`) по файлам: кейсы одного файла идут
 * одним прогоном, и файлу нужен самый долгий из их пределов. Негодное значение до сюда не
 * доходит — чтение кейсов отбрасывает его (store, потолок в контрактах).
 */
function ownCaseLimits(automated) {
  const byFile = new Map();
  for (const { group, item } of automated) {
    const minutes = item.automation.timeoutMinutes;
    if (!minutes) continue;
    const prior = byFile.get(item.automation.file);
    const ids = [...(prior?.ids ?? []), `${group}:${item.id}`];
    byFile.set(item.automation.file, { minutes: Math.max(prior?.minutes ?? 0, minutes), ids });
  }
  return byFile;
}

function runCap(options, fileCount, planTimeout, caseLimits = new Map()) {
  const flag = options['case-timeout'];
  const env = process.env[CASE_TIMEOUT_ENV]?.trim();
  const raw = flag ?? (env || undefined);
  const source = flag !== undefined ? '--case-timeout' : raw ? CASE_TIMEOUT_ENV : 'по умолчанию';
  const minutes =
    raw === undefined ? CASE_TIMEOUT_DEFAULT_MIN : Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`${source} ждёт минуты числом больше нуля, а пришло «${raw}».`);
  }
  const perCase = Math.round(minutes * 60_000);
  const files = Math.max(1, fileCount);
  // Свой предел кейса сильнее общего (по умолчанию и переменной окружения), `--case-timeout`,
  // названный в самой команде, — сильнее него: человек сказал это сейчас.
  const own = flag === undefined ? [...caseLimits.values()] : [];
  const ownMs = own.reduce((sum, limit) => sum + Math.round(limit.minutes * 60_000), 0);
  const total = perCase * Math.max(0, files - own.length) + ownMs;
  const plan = planTimeout && flag === undefined;
  const wanted = plan ? planTimeout : total;
  const ms = Math.min(wanted, TIMER_MAX_MS);
  const fmt = (value) => `${Math.round((value / 60_000) * 100) / 100} мин`;
  const clamped = ms < wanted ? `; таймер дольше ${fmt(TIMER_MAX_MS)} не умеет` : '';
  const named = own
    .map((limit) => `${limit.ids.join(', ')} — ${fmt(limit.minutes * 60_000)}`)
    .join('; ');
  let shown = `${fmt(perCase)} на кейс × ${files} = ${fmt(ms)} (${source}${clamped})`;
  if (plan) shown = `${fmt(ms)} (timeoutMinutes своей команды${clamped})`;
  else if (own.length > 0)
    shown =
      `${fmt(ms)}: свой предел кейса ${named}; остальным ${fmt(perCase)} × ` +
      `${files - own.length} (${source}${clamped})`;
  return { ms, shown };
}

/**
 * Команда прогона без блокировки: по пределу снимается всё её дерево (оболочка,
 * раннер, его воркеры). `spawnSync` с `timeout` снимал одну оболочку — vitest
 * и dev-сервер под ней жили дальше и держали порты.
 *
 * План с метками хода vitest (`plan.progress`) читается всегда, не только коротким
 * выводом: метки из вывода вырезаются, остальное идёт человеку как было. По ним
 * прогон останавливается на первом признаке синхронной блокировки — остальные тесты
 * такого файла шли бы тем же путём (23.10.2026: 42 мин одного файла), — а снятый
 * прогон называет файлы, которые не закончили.
 */
async function runPlan(plan, brief, timeoutMs) {
  const { stopTreeWithGrace } = await import(
    pathToFileURL(join(REPO, 'apps', 'server', 'src', 'lib', 'kill-tree.mjs')).href
  );
  const spawnedAt = Date.now();
  const piped = brief || Boolean(plan.progress);
  const child = spawn(plan.line, {
    cwd: plan.cwd,
    // Труба вместо терминала гасит цвета vitest — человеку у терминала их возвращаем.
    env: {
      ...process.env,
      ...(piped && !brief && process.stdout.isTTY ? { FORCE_COLOR: '1' } : {}),
      ...plan.env,
    },
    shell: true,
    stdio: piped ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  const out = { stdout: '', stderr: '' };
  const progress = plan.progress ? newProgress() : undefined;
  let timedOut = false;
  let syncBlock;
  let cancelEscalate = () => {};
  const stopTree = () => {
    // Корень, пропустивший SIGTERM мимо ушей (POSIX), держал `run` без конца:
    // через запас — SIGKILL по своему дескриптору, номер чужим не станет.
    cancelEscalate = stopTreeWithGrace(child, { spawnedAt, graceMs: KILL_GRACE_MS });
  };
  const see = (event) => {
    progress.see(event);
    if (syncBlock || timedOut || event.e !== 'case' || event.state !== 'failed') return;
    if (!isSyncBlock(event.ms, event.limit)) return;
    // Где — от корня проекта, как у кейсов: метка несёт абсолютный путь (`plan.cwd` — корень).
    syncBlock = {
      where: `${projectRelative(plan.cwd, event.file)} > ${event.name}`,
      ms: event.ms,
      limit: event.limit,
    };
    console.log(`\nСинхронная блокировка теста — останавливаю дерево процессов (${plan.line}).`);
    stopTree();
  };
  const flushers = [];
  if (piped) {
    for (const name of ['stdout', 'stderr']) {
      const take = (text) => {
        if (brief) {
          if (out[name].length < BRIEF_MAX_BUFFER) out[name] += text;
        } else process[name].write(text);
      };
      let rest = '';
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        if (!progress) return take(chunk);
        const lines = `${rest}${chunk}`.split('\n');
        rest = lines.pop() ?? '';
        let kept = '';
        for (const line of lines) {
          const event = progressEvent(line);
          if (event) see(event);
          else kept += `${line}\n`;
        }
        if (kept) take(kept);
      });
      flushers.push(() => {
        if (rest && !progressEvent(rest)) take(rest);
        rest = '';
      });
    }
  }
  const timer = setTimeout(() => {
    if (syncBlock) return;
    timedOut = true;
    console.log(`\nПрогон дольше предела — останавливаю дерево процессов (${plan.line}).`);
    stopTree();
  }, timeoutMs);
  const status = await new Promise((done) => {
    let drain;
    child.on('error', () => done(null));
    // Внук, ушедший в фон с унаследованным выводом (`sleep 1000 &`, сервер из
    // теста), держит трубу, и `close` ждал его жизнь целиком — и после предела
    // (F-66). Конец прогона — выход самой команды: остаток вывода дочитывается
    // запасом, потом трубы закрываются.
    child.on('exit', (code) => {
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(code);
      }, DRAIN_MS);
    });
    child.on('close', (code) => {
      clearTimeout(drain);
      done(code);
    });
  });
  clearTimeout(timer);
  cancelEscalate();
  for (const flush of flushers) flush();
  return {
    status: timedOut || syncBlock ? TIMEOUT_EXIT : status,
    ...out,
    timedOut,
    syncBlock,
    progress,
  };
}

const xml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Прогон снят по пределу — кейсы в историю проваленными с причиной: без записи
 * проверка конца хода видела «прогона не было», а человек — зелёный прошлый итог.
 * Общий отчёт раннера к этому моменту не дописан, ему не верим. Но отчёт, что
 * звено цепочки (пакет vitest, модуль Go, класс Gradle) успело дописать до
 * предела, — настоящий итог его кейсов (F-126): зелёные кейсы этих звеньев
 * ложились проваленными. Проваленными по пределу — только кейсы, чей файл ни
 * одним таким отчётом не назван; совпади кейс с обоими — побеждает худший.
 */
function finishedPart(plan, started) {
  if (!plan.collect) return '';
  try {
    const content = plan.collect(started, { quiet: true })?.content ?? '';
    return content
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<\/?testsuites\b[^>]*>/g, '')
      .trim();
  } catch {
    return '';
  }
}

/**
 * `syncBlock` — прогон остановлен не пределом, а признаком синхронной блокировки: та же
 * запись проваленными, своя причина. `unfinished` — файлы, что не закончили, в причину.
 */
async function recordTimeout(
  project,
  { plan, automated, cap, started, picked, options, stamps, syncBlock, unfinished = [] },
) {
  const seconds = Math.round((Date.now() - started) / 1000);
  const named =
    unfinished.length > 0 ? ` Не закончили: ${unfinished.slice(0, 10).join(', ')}.` : '';
  const reason = syncBlock
    ? `Остановлен: синхронная блокировка — ${syncBlock.where} шёл ${secs(syncBlock.ms)} с при пределе ` +
      `${secs(syncBlock.limit)} с; vitest такой тест не прерывает, остальные тесты файла шли бы так же. ` +
      `Прогон шёл ${seconds} с, дерево процессов снято.${named}`
    : `Предел времени: прогон шёл ${seconds} с, предел ${cap.shown}. Дерево процессов прогона снято.${named}`;
  const cut = syncBlock ? 'синхронная блокировка' : 'по пределу времени';
  const suite = (entries) => {
    if (entries.length === 0) return '';
    const cases = entries
      .map(({ item }) => {
        // `[id]` — первым: метка кейса сильнее догадки по имени; `@` в заголовке читался бы ключом.
        const name = `[${item.id}] ${String(item.title ?? '').replace(/@/g, '')}`;
        return `<testcase classname="${xml(item.automation.file)}" name="${xml(name)}" time="${seconds}"><failure message="${xml(reason)}" type="timeout"/></testcase>`;
      })
      .join('');
    return `<testsuite name="tests-cli run: timeout" tests="${entries.length}" failures="${entries.length}">${cases}</testsuite>`;
  };
  const finished = finishedPart(plan, started);
  const left = automated.filter(
    ({ item }) => !finished || !finished.includes(`="${xml(item.automation.file)}"`),
  );
  const { importResults } = await domain('import-results');
  const write = (body) =>
    importResults(project, {
      format: 'junit',
      content: `<?xml version="1.0" encoding="UTF-8"?><testsuites>${body}</testsuites>`,
      origin: plan.origin,
      scope: syncBlock
        ? `tests-cli run (снят: синхронная блокировка): ${plan.line}`
        : `tests-cli run (снят по пределу ${cap.shown}): ${plan.line}`,
      exitCode: TIMEOUT_EXIT,
      ...(options.group || picked ? { groups: [...new Set(automated.map((e) => e.group))] } : {}),
      stamps,
    });
  let imported;
  try {
    imported = write(`${finished}${suite(left)}`);
  } catch {
    // Отчёт звена оборван посреди записи — ему не верим, как и общему.
    imported = write(suite(automated));
  }
  console.log(reason);
  printImport(
    imported,
    left.length < automated.length
      ? `Кейсы записаны: успевшие звенья — своим итогом, остальные (${left.length}) — проваленными: ${cut}`
      : `Кейсы записаны проваленными: ${cut}`,
  );
}

/** Код выхода прогона, не начатого без стенда (`--health`), — EX_TEMPFAIL: повторить позже. */
const STAND_DOWN_EXIT = 75;

/** Стенд отвечает? Любой ответ ниже 500 (401 гейта тоже) — «жив», как у `qa/junit-run.mjs`. */
async function standAnswers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Стенд не ответил до прогона (T3, g5 25.10): e2e без стенда падали на сетапе («Error
 * reading storage state from inst/.auth/user.json»), история ложилась красной 15/15, и
 * доставка требовала прогона на развилке, который упал на своём окружении. Теперь кейсы
 * ложатся «заблокирован» с причиной — ворота читают это как окружение, а не как дефект
 * ветки, и прогона на развилке не требуют. `<skipped>` — чтобы чужой инструмент JUnit
 * тоже не увидел провала.
 */
async function recordStandDown(project, { plan, automated, picked, options, stamps, down }) {
  const reason = `Стенд ${down.join(', ')} не отвечает — прогон не запускался.`;
  const cases = automated
    .map(({ item }) => {
      const name = `[${item.id}] ${String(item.title ?? '').replace(/@/g, '')}`;
      return `<testcase classname="${xml(item.automation.file)}" name="${xml(name)}" status="blocked"><skipped message="${xml(reason)}"/></testcase>`;
    })
    .join('');
  const { importResults } = await domain('import-results');
  const imported = importResults(project, {
    format: 'junit',
    content:
      `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="tests-cli run: stand down" ` +
      `tests="${automated.length}" skipped="${automated.length}">${cases}</testsuite></testsuites>`,
    origin: plan.origin,
    scope: `tests-cli run (стенд ${down.join(', ')} не ответил): ${plan.line}`,
    exitCode: STAND_DOWN_EXIT,
    ...(options.group || picked ? { groups: [...new Set(automated.map((e) => e.group))] } : {}),
    stamps,
  });
  console.log(reason);
  printImport(imported, `Кейсы записаны «заблокирован»: стенд не ответил, прогон не запускался`);
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
    // Окружение набора меняет итог при той же строке — оно в ключе.
    .update(`${stable}\0${plan.cwd}\0${[...files].sort().join('\0')}\0${plan.envKey ?? ''}`)
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
  // `{copy}` — корень копии; на развилке — исходной, где лежат её файлы вне git (venv).
  const copy = process.env[BASE_COPY_ENV] || project;
  let own = command.replaceAll('{copy}', copy);
  if (copy !== project) {
    const fork = expandCopyPaths(own, copy, project);
    if (fork.expanded.length)
      console.log(`Пути копии вне git — из копии, на развилке их нет: ${fork.expanded.join(', ')}`);
    own = fork.line;
  }
  const line = /\{files\}|\{paths\}/.test(own)
    ? own.replaceAll('{files}', list).replaceAll('{paths}', list)
    : `${own} ${list}`;
  if (!line.includes('{report}')) return { line, cwd: project, env: {}, origin: 'ci' };
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const report = join(temp, 'junit.xml');
  return {
    line: line.replaceAll('{report}', shellQuote(report)),
    cwd: project,
    env: { AGENTDECK_JUNIT_REPORT: report },
    results: ['junit', report],
    ownReport: report,
    temp,
    origin: 'ci',
  };
}

/** Родной вывод, который сбор automation.json сводит в JUnit. */
const NATIVE_REPORTS = new Set(['go-test-json', 'cargo-test']);

/**
 * Вид отчёта, который `--cmd` оставил в `{report}`: `--format` назван — он, иначе по
 * содержимому. Строка JSON с `"Action"` — `go test -json`, строки `test … ... ok` /
 * `test result:` — `cargo test`; XML и прочее — JUnit, как раньше. Без этого вывод
 * go -json читался JUnit-ом как ноль тестов, и группа писала свой переводчик (25.10.2026).
 */
function nativeFormatOf(report, explicit) {
  if (explicit && explicit !== true) return NATIVE_REPORTS.has(explicit) ? explicit : undefined;
  let head;
  try {
    // trimStart снимает и BOM.
    head = readFileSync(report, 'utf8').trimStart();
  } catch {
    return undefined;
  }
  if (head.startsWith('<')) return undefined;
  if (/^\{.*"Action"\s*:/m.test(head)) return 'go-test-json';
  if (/^test (?:.+? \.\.\. (?:ok|FAILED|ignored)|result: )/m.test(head)) return 'cargo-test';
  return undefined;
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
      process.env[BASE_COPY_ENV]
        ? `Раннер автотестов не найден в дереве развилки ${command.cwd} (run --base, не копия): ${forkDepsTip()}`
        : `Раннер автотестов не установлен, а сам он не ставится. Выполните в ${runDirOf(project, command)}: ${command.install}`,
    );
  }
  return {
    line: command.line,
    cwd: command.cwd,
    env: command.env,
    results: ['junit', report],
    temp,
    origin: 'e2e',
    // Адрес стенда для `--health` — из конфига Playwright каталога запуска (M3).
    ...(folder.framework === 'playwright'
      ? {
          playwright: [
            {
              cwd: command.cwd,
              files: files.map((file) => relative(command.cwd, join(project, file))),
            },
          ],
        }
      : {}),
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

/** Окончание записанного прохода панели — то же, что у `recorded/codegen.ts` и `junit-run.mjs`. */
const RECORDED_SUFFIX = '.recorded.mjs';

/**
 * Только записанные проходы панели (`*.recorded.mjs`, R4): они идут запускателем этого репозитория
 * над проектом, а не командой проекта — спек самостоятелен (библиотека playwright, код выхода), и
 * своей команды, которая его знает, у чужого проекта нет. Смешанный набор сюда не попадает: его
 * ведёт команда проекта, как раньше.
 */
function recordedPlan(project, files) {
  if (files.length === 0 || !files.every((file) => file.endsWith(RECORDED_SUFFIX)))
    return undefined;
  const temp = mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const report = join(temp, 'junit.xml');
  const runner = join(REPO, 'tools', 'qa', 'junit-run.mjs');
  return {
    line: `node ${shellQuote(runner)} --project ${shellQuote(project)} ${files.map(shellQuote).join(' ')}`,
    cwd: project,
    env: { AGENTDECK_JUNIT_REPORT: report },
    results: ['junit', report],
    ownReport: report,
    temp,
    origin: 'e2e',
    // Проход идёт по стенду: память прогонов его не повторяет — стенд меняется без правки файлов.
    stand: true,
    recorded: true,
  };
}

/**
 * Переменные окружения стенда для `run --env <id>`: адрес (`E2E_BASE_URL` и родня) и доступы из
 * хранилища панели. Значения — только в процесс прогона: в вывод идут имена недостающих, не
 * значения. Каталог данных панели — `AGENTDECK_TESTS_APP_DATA` (проверки ведут его во временную
 * папку), иначе тот же, что у сервера.
 */
async function standRunEnv(project, environmentId) {
  const { readEnvironments } = await domain('library');
  const environment = readEnvironments(project).find((item) => item.id === environmentId);
  if (!environment) {
    throw new Error(`Окружения «${environmentId}» нет в .agent/tests/environments.json.`);
  }
  const { runSecrets } = await domain('env-secrets');
  const { standEnv } = await domain('e2e-run');
  const appData =
    process.env.AGENTDECK_TESTS_APP_DATA ||
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), BRAND_SLUG);
  const { values, missing } = runSecrets(appData, project, environment);
  if (missing.length)
    console.log(
      `Окружение ${environmentId}: нет значений доступов ${missing.map((ref) => ref.name).join(', ')} — ` +
        'шаги с ними лягут «не проверено». Значения заводятся в панели: «Тесты» → «Окружения».',
    );
  return { ...values, ...standEnv(environment) };
}

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
  if (!files.every((file) => vitestCaseFile(project, file))) return undefined;
  const { readAutomation } = await domain('automation');
  const { automation } = readAutomation(project);
  if (automation && !nativeAutomation(automation)) return undefined;
  if (!automation && rootTestScript(project)) return undefined;
  return await vitestRuns(project, files);
}

/**
 * Файл кейса JS-пакета: набор vitest, спек пакета со своим Playwright; кейс-набор
 * (`file` — каталог) тоже — внутри JS-пакета, не в корне проекта. Раннер выбирает
 * `packageRunner`.
 */
function vitestCaseFile(project, file) {
  if (VITEST_FILE.test(file)) return true;
  if (SPEC_FILE.test(file)) return playwrightPackage(join(project, packageRootOf(project, file)));
  return file.endsWith('/') && packageRootOf(project, `${file}x`) !== '';
}

/** Спек Playwright по имени: `*.spec.*` у пакета со своим Playwright идёт его раннером. */
const SPEC_FILE = /\.spec\.[cm]?[jt]sx?$/;
const PLAYWRIGHT_CONFIG = /^playwright\.config\.[cm]?[jt]s$/;
const PACKAGE_DEPS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Пакет Playwright: свой `playwright.config.*` у корня пакета или Playwright в
 * зависимостях без vitest. Спеки такого пакета vitest не прогонит — «vitest не
 * установлен в QA/auto/frontend», и группа собирала команду Playwright руками
 * четырьмя `--cmd` (g5, 25.10.2026).
 */
function playwrightPackage(cwd) {
  try {
    if (readdirSync(cwd).some((name) => PLAYWRIGHT_CONFIG.test(name))) return true;
  } catch {
    return false;
  }
  const deps = packageDeps(cwd);
  return (deps.has('@playwright/test') || deps.has('playwright')) && !deps.has('vitest');
}

function packageDeps(cwd) {
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return new Set(PACKAGE_DEPS.flatMap((key) => Object.keys(manifest?.[key] ?? {})));
  } catch {
    return new Set();
  }
}

/**
 * Раннер файла кейса в его пакете: `*.test.*` — vitest, если он есть у пакета; спеки
 * и каталоги пакета Playwright — Playwright; остальное — vitest, как было.
 */
function packageRunner(cwd, file) {
  if (VITEST_FILE.test(file) && vitestEntry(cwd)) return 'vitest';
  return playwrightPackage(cwd) ? 'playwright' : 'vitest';
}

/** Своя команда проекта пишет родной отчёт Go или Cargo — файлы vitest ей не по зубам. */
function nativeAutomation(automation) {
  return Boolean(automation?.format) && automation.format !== 'junit';
}

/**
 * Смешанный набор: кейсы vitest и кейсы своей команды Go/Cargo одним `run --case`.
 * Своя команда брала весь набор, `{go-modules}` файлов `*.test.ts` не исполнял, и кейсы
 * vitest уходили «без результата», а группа гоняла их второй раз (25.10.2026). Теперь
 * файлы vitest идут своим vitest пакета, остальные — своей командой, одной цепочкой и
 * одной записью истории со всеми итогами. Звено — в скобках с `|| echo -`, как у
 * `{go-modules}`: провал одного не обрывает другое, красное — по отчёту.
 */
async function mixedPlan(project, files, whole) {
  const js = files.filter((file) => vitestCaseFile(project, file));
  if (js.length === 0 || js.length === files.length) return undefined;
  const { readAutomation } = await domain('automation');
  const { automation } = readAutomation(project);
  if (!nativeAutomation(automation)) return undefined;
  const own = await automationPlan(
    project,
    files.filter((file) => !js.includes(file)),
    whole,
  );
  let web;
  try {
    web = await vitestRuns(project, js, own.temp);
  } catch (error) {
    dropTemp(own.temp);
    throw error;
  }
  // Скобки cmd — не подоболочка: `cd` звена vitest остаётся, своя команда входит в корень сама.
  const links = [...web.links, `${enterDir(own.cwd)}${own.line}`];
  let missing = false;
  return {
    ...own,
    line: links.map((link) => `(${link} || echo -)`).join(' && '),
    playwright: web.playwright,
    env: { ...web.env, ...own.env },
    progress: true,
    reportShown: `${web.reportShown}, ${own.reportShown}`,
    failed: (content) => missing || /<(failure|error)\b/.test(content),
    collect: (started, { quiet = false } = {}) => {
      const fromWeb = web.collect(started, { quiet });
      const fromOwn = own.collect(started);
      if (!fromOwn && !quiet)
        console.log(
          `Отчёт ${own.reportShown} своей команды этим прогоном не записан — её кейсы не тронуты.`,
        );
      missing = web.missed() || !fromOwn;
      const bodies = [fromWeb, fromOwn].filter(Boolean).map((part) =>
        part.content
          .replace(/<\?xml[^>]*\?>/g, '')
          .replace(/<\/?testsuites\b[^>]*>/g, '')
          .trim(),
      );
      if (bodies.length === 0) return undefined;
      return {
        content: `<testsuites>\n${bodies.join('\n')}\n</testsuites>\n`,
        files: (fromWeb?.files ?? 0) + (fromOwn?.files ?? 0),
      };
    },
  };
}

/** Вход в каталог звена цепочки: `cd /d` у cmd (иначе диск не сменится), `cd` у sh. */
function enterDir(dir) {
  return `${process.platform === 'win32' ? 'cd /d' : 'cd'} ${shellQuote(dir)} && `;
}

/**
 * Прогон файлов vitest по их пакетам. `temp` — каталог отчётов чужого плана (смешанный
 * набор), иначе свой. `links` — звенья цепочки без скобок: смешанный набор дописывает своё.
 */
async function vitestRuns(project, files, sharedTemp) {
  // Пути файлов пишет и агент (`automation.file`): та же защита от подстановок оболочки, что у `{files}`.
  const { shellArg, playwrightFileArg } = await domain('e2e-command');
  const { jsSuiteRunPaths } = await domain('suites');
  // Кейс-набор — файлами, которыми он владеет: каталог корня пакета дал бы весь пакет.
  const owned = files.flatMap((file) =>
    file.endsWith('/')
      ? jsSuiteRunPaths(project, packageRootOf(project, `${file}x`), file)
      : [file],
  );

  // Пакет и раннер: у пакета с vitest и Playwright `*.test.*` идут в vitest, спеки — в Playwright.
  const byRun = new Map();
  for (const file of owned) {
    const dir = packageRootOf(project, file);
    const runner = packageRunner(upperDrive(join(project, dir)), file);
    const key = `${dir}\n${runner}`;
    const run = byRun.get(key) ?? { dir, runner, files: [] };
    run.files.push(file);
    byRun.set(key, run);
  }
  const temp = sharedTemp ?? mkdtempSync(join(tmpdir(), 'cc-tests-run-'));
  const runs = [...byRun.values()]
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.runner.localeCompare(b.runner))
    .map((run, index) => ({ ...run, report: join(temp, `${run.runner}-${index}.xml`) }));
  const parts = runs.map(({ dir, runner, files: own, report }) => {
    const cwd = upperDrive(join(project, dir));
    const bin = runner === 'playwright' ? playwrightEntry(cwd) : vitestEntry(cwd);
    if (!bin) {
      if (!sharedTemp) dropTemp(temp);
      const name = runner === 'playwright' ? 'Playwright' : 'vitest';
      // На развилке `npm install` в копии ничего не меняет (M3, g5 27.10: группа поставила
      // зависимости копии, «up to date», и снова упала) — назван каталог дерева развилки.
      if (process.env[BASE_COPY_ENV])
        throw new Error(
          `${name} не найден в дереве развилки ${cwd} (run --base, не копия): ${forkDepsTip()}`,
        );
      throw new Error(
        runner === 'playwright'
          ? `Playwright не установлен в ${dir || '.'} (пакет со своим playwright.config), а сам он не ставится. Выполните там npm install и повторите.`
          : `vitest не установлен в ${dir || '.'}, а сам он не ставится. Установите зависимости пакета и повторите.`,
      );
    }
    if (runner === 'playwright') return playwrightLink(cwd, bin, own, report, playwrightFileArg);
    const inside = own.map((file) => (dir ? file.slice(dir.length + 1) : file));
    // Из каталога пакета, а не корня проекта: `--root` не меняет process.cwd, а Babel
    // (react-compiler в vite-плагине) ищет свои плагины от cwd — из корня монорепо без
    // node_modules каждый набор падал на трансформе, «no tests» (widget-app, 20.10.2026).
    return (
      `${enterDir(cwd)}${shellQuote(process.execPath)} ${shellQuote(bin)} run --root ${shellQuote(cwd)} ` +
      `--reporter=default --reporter=junit --reporter=${shellQuote(PROGRESS_REPORTER)} ` +
      `--outputFile.junit=${shellQuote(report)} ${inside.filter(Boolean).map(shellArg).join(' ')}`
    );
  });
  const chained = parts.length > 1;
  let missing = false;
  return {
    // Звено в скобках, как у `{go-modules}`: без них cmd пропускал всё после зелёного звена.
    line: chained ? parts.map((part) => `(${part} || echo -)`).join(' && ') : parts[0],
    links: parts,
    // Пакеты Playwright и их файлы от корня пакета — адрес стенда для `--health` (M3).
    playwright: runs
      .filter(({ runner }) => runner === 'playwright')
      .map(({ dir, files: own }) => ({
        cwd: upperDrive(join(project, dir)),
        files: own.map((file) => (dir ? file.slice(dir.length + 1) : file)),
      })),
    missed: () => missing,
    cwd: project,
    env: {},
    temp,
    origin: 'ci',
    // Метки `vitest-progress-reporter` в выводе: `runPlan` по ним видит, кто держит прогон.
    progress: true,
    reportShown: [...new Set(runs.map((run) => `${temp}/${run.runner}-*.xml`))].join(', '),
    // Цепочка гасит код провала (`|| echo -`): красное — из самого отчёта, и пакет
    // без отчёта (упал до тестов) тоже красный.
    failed: (content) => chained && (missing || /<(failure|error)\b/.test(content)),
    // `quiet` — сбор после снятия по пределу: недописавшие пакеты ложатся
    // проваленными, «не тронуты» там было бы неправдой.
    collect: (started, { quiet = false } = {}) => {
      const bodies = [];
      for (const { dir, runner, report } of runs) {
        if (!freshSince(report, started)) {
          if (!quiet)
            console.log(`Пакет ${dir || '.'}: ${runner} отчёта не записал — его кейсы не тронуты.`);
          missing = true;
          continue;
        }
        let xml = readFileSync(report, 'utf8')
          .replace(/<\?xml[^>]*\?>/g, '')
          .replace(/<\/?testsuites\b[^>]*>/g, '');
        // Playwright пишет имя набора и classname путём от своего конфига через `path.sep`.
        if (runner === 'playwright') xml = posixSuitePaths(xml);
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
/**
 * Подсказка ошибки зависимостей на развилке `--base`: дерево — `git worktree` базовой ветки,
 * `npm install` в копии его не трогает; связаны только node_modules пакетов с тем же
 * package.json и lock-файлом, что у копии (список — в строке «node_modules копии» выше).
 */
function forkDepsTip() {
  return (
    'npm install в копии не поможет — дерево развилки своё. node_modules копии связываются ' +
    'только у пакетов с тем же package.json и lock-файлом (строка «node_modules копии» выше); ' +
    'у этого пакета они разошлись с базой — его кейсы идут без --base.'
  );
}

function upperDrive(path) {
  return process.platform === 'win32'
    ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
    : path;
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

/**
 * Входной файл Playwright пакета (`@playwright/test` или `playwright`) — тот же довод,
 * что у `vitestEntry`: `.bin/playwright.cmd` без `call` не вернулся бы в цепочку.
 */
function playwrightEntry(cwd) {
  for (const name of ['@playwright/test', 'playwright']) {
    try {
      const manifest = createRequire(join(cwd, 'package.json')).resolve(`${name}/package.json`);
      const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin;
      const entry = typeof bin === 'string' ? bin : bin?.playwright;
      if (entry) return join(dirname(manifest), entry);
    } catch {
      // нет этого пакета — следующий
    }
  }
  return undefined;
}

/**
 * Звено Playwright: из каталога пакета (там его конфиг, от него пути отчёта), файлы и
 * каталоги — регулярками по пути от корня проекта (`playwrightFileArg`). JUnit — в
 * свой файл звена переменными отчёта; INCLUDE_RETRIES — как у папки e2e, ради карантина.
 */
function playwrightLink(cwd, bin, files, report, fileArg) {
  const env = {
    PLAYWRIGHT_JUNIT_OUTPUT_FILE: report,
    PLAYWRIGHT_JUNIT_OUTPUT_NAME: report,
    PLAYWRIGHT_JUNIT_INCLUDE_RETRIES: '1',
  };
  return (
    `${enterDir(cwd)}${envSet(env)}${shellQuote(process.execPath)} ${shellQuote(bin)} test ` +
    `${files.map((file) => fileArg(file)).join(' ')} --reporter=list,junit`
  );
}

/** Переменные одного звена цепочки: `set "K=V" &&` у cmd, `K='V' ` перед командой у sh. */
function envSet(vars) {
  return Object.entries(vars)
    .map(([key, value]) =>
      process.platform === 'win32' ? `set "${key}=${value}" && ` : `${key}=${shellQuote(value)} `,
    )
    .join('');
}

/** Имя набора и classname — через `/`: Playwright на Windows пишет их через `\`. */
function posixSuitePaths(xml) {
  return xml.replace(
    /(<testsuite\b[^>]*?\bname="|\bclassname=")([^"]*)"/g,
    (_all, head, name) => `${head}${name.replace(/\\/g, '/')}"`,
  );
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
    // --tree: отчёт снят на ЭТОМ дереве (gate-run передаёт, когда гейт дерево не менял) —
    // зелёный засчитают и кейсу другой группы с тем же автотестом (`sameTreeGreens`).
    // Отпечаток берётся сейчас: тот же `treeFingerprint`, что пишет `run`.
    const tree = options.tree ? (await domain('check-memo')).treeFingerprint(project) : undefined;
    return printImport(
      importResults(project, { format, file: inside, ...groups, ...(tree ? { tree } : {}) }),
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

/** `junit` — текст отчёта: счёт «упало / прошло» виден сразу, без чтения истории. */
function printImport(result, title, junit) {
  console.log(`\n${title}`);
  if (junit !== undefined) {
    const counts = junitCounts(junit);
    console.log(
      `  итог отчёта: упало ${counts.failed} / прошло ${counts.passed}` +
        (counts.skipped ? ` / пропущено ${counts.skipped}` : ''),
    );
  }
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
