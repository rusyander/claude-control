/**
 * Фоновый наблюдатель — через настоящий интерфейс, настоящий сервер и
 * настоящий запуск CLI. Подменена только модель: на PATH лежит фальшивый
 * `claude`, который пишет свой argv, рабочий каталог, окружение и промпт в
 * файл и отвечает находкой в том же формате, что ждёт разборщик.
 *
 * Своя одноразовая панель (конфигурация Claude в temp, отчёт в temp через
 * `AGENTDECK_WATCH_REPORT`) и свой Vite; стенд человека не нужен и не
 * трогается. Что проверяется:
 *
 *   1. выключен — строка в боковой панели «выкл» и ведёт на страницу
 *      наблюдателя, сбой страницы никуда не уходит;
 *   2. «Запустить наблюдателя» на странице включает, строка показывает
 *      подсказку, время и расход;
 *   3. ошибка страницы с секретом внутри → раздел в отчёте сразу, секрета в
 *      отчёте нет, после разбора — вердикт и место в коде;
 *   4. запуск модели: только Read/Grep/Glob, рабочий каталог — корень
 *      приложения, посаженная переменная окружения до процесса не дошла;
 *   5. 5xx запроса страницы (ответ подменён на границе сети) → раздел с путём;
 *   6. окно индикатора: фокус внутрь, Escape и клик мимо — фокус обратно, окно
 *      помещается на экране после смены размера; «Открыть страницу» с другой
 *      страницы — страница наблюдателя с кнопкой «Остановить»;
 *   7. упавший разбор → проблема словами в сводке на странице;
 *   8. «Выключить» — строка снова «выкл», новый сбой не уходит и отчёт не растёт;
 *   9. все проблемы, не только сбои: 400 из интерфейса дважды → ОДИН раздел
 *      с повторов 2; предупреждение консоли; медленный ответ (фальшивый
 *      `--version` тянет дольше порога); зависшая загрузка (ответ задержан на
 *      границе сети); одно и то же замечание модели → один раздел; у каждого
 *      раздела свой WR-n, и все они в оглавлении;
 *  10. негативы на отдельных панелях: CLI нет на PATH → `cli_missing`, а
 *      раздел всё равно записан; отчёт не записывается → `report_unwritable`,
 *      панель жива и наблюдатель включён; потолок 1 разбор в час → второй
 *      разбор не запущен, `hourly_cap`, раздел записан «проверяется».
 *
 * Снимки: `.agent/screenshots/before-after/watcher/after-*.png`.
 * Запуск: `node tools/qa/check-watcher.mjs` (порты WATCH_PANEL_PORT/
 * WATCH_WEB_PORT, по умолчанию 5271/8981; негативам — 5272/5273).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PANEL_PORT = Number(process.env.WATCH_PANEL_PORT ?? 5271);
const WEB_PORT = Number(process.env.WATCH_WEB_PORT ?? 8981);
const NEG_PORTS = [PANEL_PORT + 1, PANEL_PORT + 2, PANEL_PORT + 3];
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const SHOTS = join(REPO, '.agent/screenshots/before-after/watcher');
const IS_WIN = process.platform === 'win32';
/** Секрет-приманка собран из кусков, чтобы сам файл не походил на утечку. */
const SECRET = ['sk', 'qa', 'watch', 'Z9y8X7w6V5u4T3s2R1'].join('-');
const PLANTED = 'WATCHER_QA_PLANTED';
const TOOLTIP_RU = 'Агент работает в фоне и собирает информацию';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
};
class NotChecked extends Error {}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(probe, seconds, step = 200) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await wait(step);
  }
}

async function waitFor(url, seconds) {
  return until(
    async () => {
      try {
        const res = await fetch(url);
        return res.status < 500 ? res : undefined;
      } catch {
        return undefined;
      }
    },
    seconds,
    250,
  );
}

function apiAt(port) {
  return async (path, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    try {
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    } catch {
      return { status: res.status, body: text };
    }
  };
}

/** Фальшивый `claude`: node-скрипт плюс обёртка под имя, которое ищет панель. */
function writeFakeClaude(bin, root) {
  const script = join(root, 'fake-claude.mjs');
  const calls = join(root, 'fake-calls.jsonl');
  const config = join(root, 'fake-config.json');
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const config = existsSync(${JSON.stringify(config)}) ? JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8')) : {};
if (argv.includes('--version')) {
  // Задержка версии — медленный ответ панели, который её ждёт.
  setTimeout(() => { process.stdout.write('9.9.9 (Claude Code)\\n'); process.exit(0); }, config.versionDelayMs ?? 0);
} else if (config.providerError && argv[argv.indexOf('--tools') + 1] !== 'Read,Grep,Glob') {
  // Ошибка провайдера у запуска панели, не у разбора наблюдателя: у того
  // --tools Read,Grep,Glob, а лёгкие окна панели передают --tools пустым.
  process.stderr.write('starting session 4f2a\\n' + config.providerError + '\\n');
  process.exit(1);
} else if (!argv.includes('-p')) process.exit(0);
else {
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, cwd: process.cwd(), env: Object.keys(process.env), prompt }) + '\\n');
  if (config.fail) { process.stderr.write('fake model failure'); process.exit(3); }
  const ids = [...prompt.matchAll(/^id: ([0-9a-f]+)$/gm)].map((m) => m[1]);
  const findings = ids.map((id) => ({ id, title: 'QA finding ' + id, happened: 'Page threw.', rootCause: 'No catch.', steps: 'Open Settings.', verdict: 'confirmed', severity: 'high', location: 'apps/web/src/main.tsx:1', fix: 'Catch it.' }));
  // Одно и то же замечание в каждом ответе — в отчёте оно должно остаться одним разделом.
  if (ids.length) findings.push({ kind: 'remark', title: 'QA remark: handler has no catch', explanation: 'The handler rethrows.', severity: 'low', location: 'apps/web/src/main.tsx:1', fix: 'Add a catch.', relatedTo: ids[0] });
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '\\u0060\\u0060\\u0060agentdeck-watch\\n' + JSON.stringify(findings) + '\\n\\u0060\\u0060\\u0060', modelUsage: { 'claude-haiku-4-5': { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 5000, cacheCreationInputTokens: 100 } } }) + '\\n');
});
}
`,
    'utf8',
  );
  if (IS_WIN) {
    writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  } else {
    const shim = join(bin, 'claude');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    chmodSync(shim, 0o755);
  }
  return { calls, config };
}

function readCalls(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const readReport = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const sectionCount = (text) => (text.match(/<!-- watch:[0-9a-f]+ /g) ?? []).length;

/** Разделы отчёта: отпечаток, атрибуты метки (ref, class, count, …) и тело. */
function sectionsOf(text) {
  const re = /<!-- watch:([0-9a-f]{6,40}) ([^\n]*?) -->\n([\s\S]*?)<!-- \/watch:\1 -->/g;
  return [...text.matchAll(re)].map((match) => ({
    id: match[1],
    attrs: Object.fromEntries(
      match[2].split(' ').map((pair) => {
        const at = pair.indexOf('=');
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    ),
    body: match[3],
  }));
}

/**
 * Остановить ровно тот процесс, что запущен здесь, по его записанному PID —
 * без `taskkill /T`: обход дерева идёт по PID родителя, которые Windows не
 * чистит, и однажды снёс чужой стенд владельца. Потомок esbuild у Vite
 * выходит сам, когда закрывается его канал к Vite.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Прямые потомки процесса (esbuild у Vite) — только чтобы проверить, что они ушли. */
function directChildren(pid) {
  if (!pid) return [];
  const out = IS_WIN
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`,
        ],
        { encoding: 'utf8' },
      ).stdout
    : spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout;
  return String(out ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
}

function makeEnv(root, extra) {
  const home = join(root, 'home');
  const cfg = join(home, '.claude');
  for (const dir of [cfg, join(home, 'AppData/Roaming'), join(home, 'AppData/Local')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(cfg, 'settings.json'), '{}\n', 'utf8');
  const homeEnv = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: cfg,
    APPDATA: join(home, 'AppData/Roaming'),
    LOCALAPPDATA: join(home, 'AppData/Local'),
  };
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['PATH', ...Object.keys(homeEnv)].includes(key.toUpperCase()),
    ),
  );
  return { ...base, ...homeEnv, ...extra };
}

/** PATH без настоящего `claude`: только системный каталог и (по желанию) подмена. */
function isolatedPath(bin) {
  const system = IS_WIN
    ? [
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        process.env.SystemRoot ?? 'C:\\Windows',
      ]
    : ['/usr/bin', '/bin'];
  return [...(bin ? [bin] : []), ...system].join(IS_WIN ? ';' : ':');
}

function startPanel(port, env) {
  return spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/index.ts'], {
    cwd: join(REPO, 'apps/server'),
    env: { ...env, PORT: String(port), WEB_PORT: String(WEB_PORT) },
    stdio: 'ignore',
    shell: false,
  });
}

async function main() {
  // Порт уже отвечает — это чужая панель: проверка пошла бы в неё и включала бы
  // там наблюдатель. Лучше не проверить, чем проверить не то.
  for (const port of [PANEL_PORT, WEB_PORT, ...NEG_PORTS]) {
    if (await waitFor(`http://127.0.0.1:${port}/`, 1))
      throw new NotChecked(
        `порт ${port} занят чужим процессом — задайте WATCH_PANEL_PORT/WATCH_WEB_PORT.`,
      );
  }
  mkdirSync(SHOTS, { recursive: true });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-watcher-qa-')));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = writeFakeClaude(bin, root);
  const report = join(root, 'report', 'WATCH-REPORT.md');
  const children = [];
  try {
    const env = makeEnv(join(root, 'main'), {
      PATH: isolatedPath(bin),
      AGENTDECK_WATCH_REPORT: report,
      AGENTDECK_WATCH_DEBOUNCE_MS: '300',
      // Пороги короче боевых — медленный ответ и зависшую загрузку не ждать минутами.
      AGENTDECK_WATCH_SLOW_MS: '1000',
      AGENTDECK_WATCH_STUCK_MS: '1500',
      // Потолок проверяется отдельной панелью; здесь он не должен вмешаться.
      AGENTDECK_WATCH_RUNS_PER_HOUR: '200',
      [PLANTED]: 'must-not-reach-the-model',
    });
    const panel = startPanel(PANEL_PORT, env);
    children.push(panel);
    const web = spawn(
      process.execPath,
      [
        join('node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: join(REPO, 'apps/web'),
        env: {
          ...env,
          PATH: process.env.PATH ?? process.env.Path,
          API_PORT: String(PANEL_PORT),
          BROWSER: 'none',
        },
        stdio: 'ignore',
        shell: false,
      },
    );
    children.push(web);
    if (!(await waitFor(`http://127.0.0.1:${PANEL_PORT}/api/system`, 40)))
      throw new NotChecked('одноразовая панель не поднялась.');
    if (!(await waitFor(WEB, 60))) throw new NotChecked('одноразовый фронт не поднялся.');
    console.log(`Панель :${PANEL_PORT}, фронт :${WEB_PORT}, отчёт ${report}\n`);

    await uiPart({ api: apiAt(PANEL_PORT), report, fake });
    await problemsPart({ api: apiAt(PANEL_PORT), report, fake });
    await negativesPart(root, children);
    await hourlyCapPart(root, children);
  } finally {
    // Прямые потомки записываются ДО остановки (только чтение): после неё их
    // PID может занять чужой процесс. Останавливаются лишь свои записанные.
    const spawnedByUs = children.flatMap((child) => [child.pid, ...directChildren(child.pid)]);
    for (const child of children) stopChild(child);
    const leftover = await until(() => spawnedByUs.filter(isAlive).length === 0, 10, 300);
    check(
      'после себя: ни одного запущенного процесса (панели, Vite, esbuild)',
      leftover === true,
      `живы: ${spawnedByUs.filter(isAlive).join(', ')}`,
    );
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function newPage(browser, language = 'ru') {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // Под автоматизацией страница молчит об отказах API, которых сервер не видел
  // (`reportApiFailure`): подменённый проверкой ответ — не сбой панели. Здесь
  // подмена и есть сбой, который проверяется, — страница ведёт себя как у человека.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
  });
  await bypassOnboarding(page, { language, theme: 'light' });
  return page;
}

/** Бросить ошибку страницы так, как её бросает код: из таймера, мимо React. */
const throwOnPage = (page, message) =>
  page.evaluate((text) => {
    setTimeout(() => {
      throw new Error(text);
    }, 0);
  }, message);

async function uiPart({ api, report, fake }) {
  const browser = await chromium.launch();
  const sent = [];
  try {
    const page = await newPage(browser);
    page.on('request', (request) => {
      if (request.url().includes('/api/watcher/events')) sent.push(request.url());
    });
    await page.goto(`${WEB}/rules`, { waitUntil: 'domcontentloaded' });
    // Строка видна всегда; «включённая» — та, у которой нет метки «выкл».
    const offRow = page.locator('[data-watcher-indicator][data-watcher-off]');
    const indicator = page.locator('[data-watcher-indicator]:not([data-watcher-off])');
    await offRow.waitFor({ timeout: 30_000 });

    // 1. Выключен: строка «выкл» ведёт на страницу наблюдателя.
    await wait(500);
    check('выключен: окна у строки нет', (await indicator.count()) === 0);
    await offRow.click();
    await page.waitForURL(/\/watcher$/, { timeout: 10_000 }).catch(() => undefined);
    const start = page.locator('[data-watcher-start]');
    await start.waitFor({ timeout: 15_000 }).catch(() => undefined);
    check(
      'выключен: строка «выкл» ведёт на страницу с «Запустить наблюдателя»',
      (await start.count()) === 1 && new URL(page.url()).pathname === '/watcher',
      page.url(),
    );
    await throwOnPage(page, 'qa before enable');
    await wait(800);
    check('выключен: сбой страницы никуда не ушёл', sent.length === 0, `запросов: ${sent.length}`);

    // 2. «Запустить наблюдателя» включает.
    await start.click();
    await indicator.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const status = (await api('/watcher')).body;
    check(
      '«Запустить наблюдателя»: сервер включён, отчёт — во временном каталоге',
      status?.enabled === true && status.reportPath === report,
      JSON.stringify(status),
    );
    const title = (await indicator.getAttribute('title')) ?? '';
    check(
      'индикатор: подсказка, время и расход',
      title.includes(TOOLTIP_RU) && /Работает \d/.test(title) && /Расход: /.test(title),
      title,
    );
    await page.screenshot({ path: join(SHOTS, 'after-watcher-page.png') });

    // 3. Ошибка страницы с секретом.
    const before = sectionCount(readReport(report));
    await wait(3500); // опрос статуса взвёл сбор (3 с)
    await throwOnPage(page, `qa watcher boom token=${SECRET}`);
    const written = await until(() => sectionCount(readReport(report)) > before, 10);
    const text = readReport(report);
    check(
      'сбой страницы: раздел в отчёте сразу',
      written === true,
      `разделов: ${sectionCount(text)}`,
    );
    check('секрета в отчёте нет', text.length > 0 && !text.includes(SECRET));
    const analysed = await until(() => readReport(report).includes('apps/web/src/main.tsx:1'), 20);
    check(
      'после разбора: вердикт и место в коде',
      analysed === true && /verdict=confirmed/.test(readReport(report)),
    );

    // 4. Запуск модели.
    const calls = readCalls(fake.calls);
    const call = calls.at(-1);
    const tools = call ? call.argv[call.argv.indexOf('--tools') + 1] : '';
    check(
      'модель: только Read,Grep,Glob',
      tools === 'Read,Grep,Glob' && call.argv.includes('--allowedTools'),
      JSON.stringify(call?.argv),
    );
    check(
      'модель: рабочий каталог — корень приложения',
      call && resolve(call.cwd).toLowerCase() === REPO.toLowerCase(),
      call?.cwd,
    );
    check('модель: посаженная переменная окружения не дошла', call && !call.env.includes(PLANTED));
    check('модель: секрета нет и в промпте', call && !call.prompt.includes(SECRET));
    const spend = (await api('/watcher')).body?.spend;
    check(
      'расход посчитан из ответа CLI',
      spend?.runs >= 1 && spend.input >= 1200 && spend.cacheRead >= 5000,
      JSON.stringify(spend),
    );

    // 5. 5xx запроса страницы.
    await page.route('**/api/skills**', (route) => route.fulfill({ status: 503, body: 'down' }));
    await page.goto(`${WEB}/skills`, { waitUntil: 'domcontentloaded' });
    const apiSection = await until(() => readReport(report).includes('/api/skills'), 15);
    check('5xx запроса страницы: раздел с путём', apiSection === true);
    await page.unroute('**/api/skills**');

    // 6. Окно индикатора.
    await page.goto(`${WEB}/rules`, { waitUntil: 'domcontentloaded' });
    await indicator.waitFor({ timeout: 15_000 });
    await indicator.click();
    const popover = page.locator('[data-watcher-popover]');
    await popover.waitFor({ timeout: 5000 });
    const focusedInside = await page.evaluate(() =>
      document.activeElement?.hasAttribute('data-watcher-turn-off'),
    );
    check('окно: фокус на первом действии', focusedInside === true);
    await page.screenshot({ path: join(SHOTS, 'after-indicator-popover.png') });
    await page.keyboard.press('Escape');
    const closed = (await popover.count()) === 0;
    const back = await page.evaluate(() =>
      document.activeElement?.hasAttribute('data-watcher-indicator'),
    );
    check('Escape: окно закрыто, фокус на индикаторе', closed && back === true);
    // Клик мимо окна — как Escape: фокус на строке, а не на body (F-178).
    await indicator.click();
    await popover.waitFor({ timeout: 5000 });
    await page.mouse.click(1000, 40);
    const backAfterClick = await page.evaluate(() =>
      document.activeElement?.hasAttribute('data-watcher-indicator'),
    );
    check(
      'клик мимо: окно закрыто, фокус на индикаторе',
      (await popover.count()) === 0 && backAfterClick === true,
    );
    // Окно идёт за строкой при смене размера окна браузера (F-179): экран стал
    // ниже — окно не вылезает за нижний край.
    await indicator.click();
    await popover.waitFor({ timeout: 5000 });
    const size = page.viewportSize();
    const box = await popover.boundingBox();
    const at = await indicator.boundingBox();
    if (size && box && at) {
      const lower = Math.round(Math.max(at.y + 60, box.height + 40));
      await page.setViewportSize({ width: size.width, height: lower });
      await page.waitForTimeout(300);
      const moved = await popover.boundingBox();
      check(
        'смена размера: окно индикатора помещается на экране',
        Boolean(moved) && moved.y + moved.height <= lower,
        moved ? `низ ${Math.round(moved.y + moved.height)} при высоте ${lower}` : 'окна нет',
      );
      await page.setViewportSize(size);
    } else {
      check('смена размера: окно индикатора измерено', false);
    }
    await page.keyboard.press('Escape');
    await indicator.click();
    await page.locator('[data-watcher-open-page]').click();
    await page.waitForURL(/\/watcher$/, { timeout: 10_000 }).catch(() => undefined);
    const stop = await page
      .locator('[data-watcher-stop]')
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    check(
      '«Открыть страницу»: страница наблюдателя, кнопка «Остановить»',
      stop && (await page.locator('[data-watcher-popover]').count()) === 0,
      page.url(),
    );

    // 7. Упавший разбор.
    writeFileSync(fake.config, JSON.stringify({ fail: true }), 'utf8');
    await throwOnPage(page, 'qa analysis will fail');
    const failed = await until(
      async () => (await api('/watcher')).body?.problem?.problemCode === 'analysis_failed',
      20,
    );
    await page
      .locator('[data-watcher-problem="analysis_failed"]')
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    const problemShown =
      (await page.locator('[data-watcher-problem="analysis_failed"]').count()) > 0;
    check(
      'упавший разбор: проблема в статусе и словами в сводке на странице',
      failed === true && problemShown,
    );
    writeFileSync(fake.config, '{}', 'utf8');

    // 8. Выключить из окна индикатора.
    await indicator.click();
    await page.locator('[data-watcher-turn-off]').click();
    const gone = await until(
      async () => (await indicator.count()) === 0 && (await offRow.count()) === 1,
      10,
    );
    check(
      '«Выключить»: строка снова «выкл», сервер выключен',
      gone === true && (await api('/watcher')).body?.enabled === false,
    );
    await wait(3500);
    const sentBefore = sent.length;
    const sectionsBefore = sectionCount(readReport(report));
    await throwOnPage(page, 'qa after disable');
    await wait(1500);
    check(
      'выключен: новый сбой не ушёл, отчёт не вырос',
      sent.length === sentBefore && sectionCount(readReport(report)) === sectionsBefore,
    );

    // Снимки в английском интерфейсе — для справки обоих языков.
    await api('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    const en = await newPage(browser, 'en');
    await en.goto(`${WEB}/watcher`, { waitUntil: 'domcontentloaded' });
    const enRow = en.locator('[data-watcher-indicator]:not([data-watcher-off])');
    await enRow.waitFor({ timeout: 20_000 });
    // Язык приходит с настройками, а строка — со статусом: что раньше, не задано.
    await until(
      async () => ((await enRow.getAttribute('title')) ?? '').includes('running in the background'),
      10,
    );
    const enTitle = (await enRow.getAttribute('title')) ?? '';
    check(
      'английский: подсказка индикатора переведена',
      enTitle.includes('running in the background'),
      enTitle,
    );
    await en.screenshot({ path: join(SHOTS, 'after-watcher-page-en.png') });
    await en.close();
    await api('/watcher', { method: 'POST', body: JSON.stringify({ enabled: false }) });
    await page.close();
  } finally {
    await browser.close();
  }
}

/**
 * Все проблемы, а не только сбои: 400 из интерфейса, предупреждение консоли,
 * медленный ответ, зависшая загрузка, замечание модели — и склейка: одна
 * причина дважды — один раздел со счётом 2.
 */
async function problemsPart({ api, report, fake }) {
  console.log('\nВсе проблемы и склейка:');
  const browser = await chromium.launch();
  try {
    await api('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    const page = await newPage(browser);
    await page.goto(`${WEB}/rules`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-watcher-indicator]').waitFor({ timeout: 20_000 });
    await wait(3500); // опрос статуса взвёл сбор и пороги

    // 400: страница дважды шлёт тело, которое не проходит схему.
    const statuses = await page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch('/api/watcher', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: 'x' }),
        });
        out.push(res.status);
      }
      return out;
    });
    const bad = (text) =>
      sectionsOf(text).filter((s) => s.body.includes('`POST /api/watcher` → 400'));
    const deduped = await until(() => bad(readReport(report))[0]?.attrs.count === '2', 10);
    const badSections = bad(readReport(report));
    check(
      '400 из интерфейса дважды: один раздел, повторов 2',
      statuses.join() === '400,400' && deduped === true && badSections.length === 1,
      JSON.stringify({ statuses, sections: badSections.map((s) => s.attrs) }),
    );

    // Предупреждение консоли.
    await page.evaluate(() => console.warn('qa console warning marker-7'));
    const warned = await until(
      () => sectionsOf(readReport(report)).some((s) => s.body.includes('marker-7')),
      10,
    );
    check('предупреждение консоли: раздел в отчёте', warned === true);

    // Медленный ответ: панель ждёт `--version`, которое тянет 1,6 с при пороге 1 с.
    writeFileSync(fake.config, JSON.stringify({ versionDelayMs: 1600 }), 'utf8');
    const slowReply = await api('/chat/cli?refresh=1');
    writeFileSync(fake.config, '{}', 'utf8');
    const slow = await until(
      () =>
        sectionsOf(readReport(report)).find(
          (s) => s.body.includes('`GET /api/chat/cli`') && s.body.includes('Длительность'),
        ),
      10,
    );
    check(
      'медленный ответ: раздел с маршрутом и длительностью',
      slowReply.status === 200 && slow !== undefined,
      `статус ${slowReply.status}`,
    );

    // Зависшая загрузка: ответ списка скиллов не приходит дольше порога 1,5 с.
    let release;
    const released = new Promise((done) => (release = done));
    await page.route('**/api/skills**', async (route) => {
      await released;
      await route.fulfill({ status: 200, body: '[]' }).catch(() => undefined);
    });
    await page.goto(`${WEB}/skills`, { waitUntil: 'domcontentloaded' });
    const stuck = await until(
      () =>
        sectionsOf(readReport(report)).find(
          (s) => /Loading took longer than/.test(s.body) && s.body.includes('skills'),
        ),
      15,
    );
    check('зависшая загрузка: раздел в отчёте', stuck !== undefined);
    release();
    await page.unroute('**/api/skills**');

    // Ошибка провайдера: запуск CLI панелью (ассистент) падает с текстом в stderr.
    // Дважды одна причина — один раздел с повторов 2 и хвостом stderr в уликах.
    writeFileSync(
      fake.config,
      JSON.stringify({ providerError: 'API Error: 529 {"type":"overloaded_error"}' }),
      'utf8',
    );
    const ask = () =>
      api('/assistant/run', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'qa provider error' }] }),
      });
    const asked = [(await ask()).status, (await ask()).status];
    writeFileSync(fake.config, '{}', 'utf8');
    const provider = (text) =>
      sectionsOf(text).filter(
        (s) => s.body.includes('API Error: 529') && s.body.includes('кодом 1'),
      );
    const providerOnce = await until(
      () => provider(readReport(report))[0]?.attrs.count === '2',
      15,
    );
    const providerSections = provider(readReport(report));
    check(
      'ошибка провайдера: причина из stderr в тексте, хвост в уликах, дважды — один раздел',
      providerOnce === true &&
        providerSections.length === 1 &&
        providerSections[0].body.includes('Вывод CLI (stderr, конец)') &&
        providerSections[0].body.includes('starting session'),
      JSON.stringify({ asked, sections: providerSections.map((s) => s.attrs) }),
    );

    // Замечание модели: в каждом ответе одно и то же — в отчёте один раздел.
    await until(async () => !(await api('/watcher')).body?.analyzing, 20);
    await wait(1000);
    const text = readReport(report);
    const all = sectionsOf(text);
    const remarks = all.filter((s) => s.attrs.class === 'remark');
    const status = (await api('/watcher')).body;
    check(
      'замечание модели: один раздел «замечание», в статусе посчитано',
      remarks.length === 1 && remarks[0].body.includes('Что не так') && status?.remarks === 1,
      JSON.stringify({ remarks: remarks.map((s) => s.attrs), statusRemarks: status?.remarks }),
    );
    const refs = all.map((s) => s.attrs.ref);
    check(
      'номера WR-n: у каждого раздела свой, все в оглавлении',
      refs.every((ref) => /^WR-\d+$/.test(ref)) &&
        new Set(refs).size === refs.length &&
        refs.every((ref) => text.includes(`| ${ref} |`)),
      refs.join(', '),
    );
    await page.screenshot({ path: join(SHOTS, 'after-problems.png') });
    await page.close();
  } finally {
    await api('/watcher', { method: 'POST', body: JSON.stringify({ enabled: false }) });
    await browser.close();
  }
}

/** Потолок разборов в час: второй разбор не запускается, проблема названа, раздел записан. */
async function hourlyCapPart(root, children) {
  console.log('\nПотолок в час:');
  const dir = join(root, 'cap');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = writeFakeClaude(bin, dir);
  const capReport = join(dir, 'WATCH-REPORT.md');
  const panel = startPanel(
    NEG_PORTS[2],
    makeEnv(join(dir, 'panel'), {
      PATH: isolatedPath(bin),
      AGENTDECK_WATCH_REPORT: capReport,
      AGENTDECK_WATCH_DEBOUNCE_MS: '200',
      AGENTDECK_WATCH_RUNS_PER_HOUR: '1',
    }),
  );
  children.push(panel);
  if (!(await waitFor(`http://127.0.0.1:${NEG_PORTS[2]}/api/system`, 40)))
    throw new NotChecked(`панель :${NEG_PORTS[2]} не поднялась.`);
  const c = apiAt(NEG_PORTS[2]);
  await c('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  const signal = (message) =>
    c('/watcher/events', {
      method: 'POST',
      body: JSON.stringify({ kind: 'window-error', message, route: '/settings' }),
    });
  await signal('qa cap first');
  const firstRun = await until(async () => {
    const s = (await c('/watcher')).body;
    return s?.spend?.runs === 1 && !s.analyzing;
  }, 20);
  check('потолок 1: первый разбор прошёл', firstRun === true && readCalls(fake.calls).length === 1);
  await signal('qa cap second');
  const capped = await until(
    async () => (await c('/watcher')).body?.problem?.problemCode === 'hourly_cap',
    10,
  );
  await wait(1000);
  const status = (await c('/watcher')).body;
  const sections = sectionsOf(readReport(capReport)).filter((s) => s.attrs.class !== 'remark');
  const second = sections.find((s) => s.body.includes('qa cap second'));
  check(
    'потолок 1: второй разбор не запущен, проблема hourly_cap, раздел записан «проверяется»',
    capped === true &&
      readCalls(fake.calls).length === 1 &&
      status?.hourlyCap?.limit === 1 &&
      status.hourlyCap.used === 1 &&
      second?.attrs.verdict === 'pending',
    JSON.stringify({
      problem: status?.problem?.problemCode,
      cap: status?.hourlyCap,
      second: second?.attrs,
    }),
  );
  await c('/watcher', { method: 'POST', body: JSON.stringify({ enabled: false }) });
}

async function negativesPart(root, children) {
  console.log('\nНегативы:');
  // CLI нет на PATH.
  const noCliReport = join(root, 'nocli', 'WATCH-REPORT.md');
  const noCli = startPanel(
    NEG_PORTS[0],
    makeEnv(join(root, 'nocli'), {
      PATH: isolatedPath(),
      AGENTDECK_WATCH_REPORT: noCliReport,
      AGENTDECK_WATCH_DEBOUNCE_MS: '200',
    }),
  );
  children.push(noCli);
  // Отчёт не записывается: его «папка» — файл.
  const blocker = join(root, 'blocker.txt');
  writeFileSync(blocker, 'not a folder', 'utf8');
  const badReport = join(blocker, 'WATCH-REPORT.md');
  const bad = startPanel(
    NEG_PORTS[1],
    makeEnv(join(root, 'bad'), {
      PATH: isolatedPath(join(root, 'bin')),
      AGENTDECK_WATCH_REPORT: badReport,
      AGENTDECK_WATCH_DEBOUNCE_MS: '200',
    }),
  );
  children.push(bad);
  for (const port of NEG_PORTS.slice(0, 2)) {
    if (!(await waitFor(`http://127.0.0.1:${port}/api/system`, 40)))
      throw new NotChecked(`панель :${port} не поднялась.`);
  }
  const signal = { kind: 'window-error', message: 'qa negative', route: '/settings' };

  const a = apiAt(NEG_PORTS[0]);
  const on = (await a('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) }))
    .body;
  check(
    'нет CLI: включается, проблема cli_missing',
    on?.enabled === true && on.problem?.problemCode === 'cli_missing',
    JSON.stringify(on?.problem),
  );
  await a('/watcher/events', { method: 'POST', body: JSON.stringify(signal) });
  check(
    'нет CLI: раздел всё равно записан',
    sectionCount(readReport(noCliReport)) === 1 && /verdict=pending/.test(readReport(noCliReport)),
  );

  const b = apiAt(NEG_PORTS[1]);
  await b('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  const accepted = (await b('/watcher/events', { method: 'POST', body: JSON.stringify(signal) }))
    .body;
  const after = (await b('/watcher')).body;
  const alive = (await b('/system')).status;
  check(
    'отчёт не пишется: report_unwritable, наблюдатель включён, панель жива',
    accepted?.accepted === true &&
      after?.enabled === true &&
      after.problem?.problemCode === 'report_unwritable' &&
      alive === 200,
    JSON.stringify({ accepted, problem: after?.problem, alive }),
  );
  await a('/watcher', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  await b('/watcher', { method: 'POST', body: JSON.stringify({ enabled: false }) });
}

main().catch((error) => {
  if (error instanceof NotChecked) {
    console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
