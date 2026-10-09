/**
 * «Нашли баг сами?» и страница отчёта наблюдателя (владелец, 09.10.2026) —
 * через настоящий интерфейс, настоящий сервер и настоящий запуск CLI.
 * Подменена только модель: на PATH лежит фальшивый `claude`, который отвечает
 * вердиктом по тексту жалобы — «Ctrl+Enter» в описании → «не в коде»,
 * иначе → подтверждён.
 *
 * Своя одноразовая панель (конфигурация Claude в temp, отчёт в temp через
 * `AGENTDECK_WATCH_REPORT`) и свой Vite; стенд человека не нужен и не
 * трогается. Что проверяется:
 *
 *   1. выключен — жалоба не принимается: 409 с кодом `watcher-off`;
 *   2. форма в окне индикатора: пустое и «ab» — «Проверить» заперта, «abc» —
 *      открыта (граница сервера — три знака);
 *   3. подтверждённый баг: строка «проверяется», затем «подтверждён — WR-n»;
 *      в отчёте раздел с текстом жалобы и источником «человек»;
 *   4. неподтверждённый (отправлен Ctrl+Enter): строка «по коду не
 *      подтвердился» с причиной модели; разделов в отчёте не прибавилось;
 *   5. задержанная отправка: кнопка заперта, пока запрос в полёте;
 *   6. «Открыть страницу» → страница: окно закрыто, путь файла, карточек столько
 *      же, сколько разделов в файле; фильтр «Подтверждённые» — только
 *      подтверждённые; пустой фильтр — «В этом фильтре разделов нет»;
 *      «Подробнее» раскрывает тело раздела из файла;
 *   7. отказ сервера → карточка ошибки, «Повторить» возвращает отчёт;
 *      файла нет → «Отчёт пуст»;
 *   8. форма на странице наблюдателя: видны все проверки, а не три; жалоба
 *      со страницы уходит без адреса (из окна — с адресом открытой страницы);
 *   9. выключение убирает проверки из статуса, на странице вместо формы —
 *      подсказка, строка в боковой панели — «выкл»; ошибок консоли нет.
 *
 * Снимки: `.agent/screenshots/before-after/watcher-bug/*_AFTER.png`.
 * Запуск: `node tools/qa/check-watcher-bug.mjs` (порты WATCH_BUG_PANEL_PORT/
 * WATCH_BUG_WEB_PORT, по умолчанию 5274/8984).
 */
import { spawn } from 'node:child_process';
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
const PANEL_PORT = Number(process.env.WATCH_BUG_PANEL_PORT ?? 5274);
const WEB_PORT = Number(process.env.WATCH_BUG_WEB_PORT ?? 8984);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const SHOTS = join(REPO, '.agent/screenshots/before-after/watcher-bug');
const IS_WIN = process.platform === 'win32';

const BUG_OK = 'После «Принять» карточка группы в хабе не меняет цвет';
const BUG_NO = 'Ctrl+Enter в поле бага ничего не отправляет';
const BUG_SLOW = 'Список чатов пустеет после перезапуска панели';
// Свой текст: одинаковую жалобу сервер склеивает с прежней проверкой, а не множит.
const BUG_PAGE = 'Фильтр отчёта сбрасывается при смене темы';
const REJECT_REASON = 'Ctrl+Enter is handled by the form and sends the description.';

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

async function api(path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Фальшивый `claude`: вердикт по тексту жалобы, задержка ответа — из файла настроек. */
function writeFakeClaude(bin, root) {
  const script = join(root, 'fake-claude.mjs');
  const config = join(root, 'fake-config.json');
  writeFileSync(
    script,
    `import { existsSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const config = existsSync(${JSON.stringify(config)}) ? JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8')) : {};
if (argv.includes('--version')) { process.stdout.write('9.9.9 (Claude Code)\\n'); process.exit(0); }
if (!argv.includes('-p')) process.exit(0);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => setTimeout(() => {
  const blocks = prompt.split(/^(?=id: [0-9a-f]+$)/m).slice(1);
  const findings = blocks.map((block) => {
    const id = block.match(/^id: ([0-9a-f]+)$/m)[1];
    if (/Ctrl\\+Enter/.test(block)) return { id, title: 'Shortcut does not send', happened: ${JSON.stringify(REJECT_REASON)}, verdict: 'not-in-code', severity: 'low' };
    return { id, title: 'QA user bug ' + id, happened: 'The card keeps its colour.', rootCause: 'QA root cause: the tree is not invalidated.', steps: 'Press Accept.', verdict: 'confirmed', severity: 'medium', location: 'apps/web/src/main.tsx:1', fix: 'Invalidate the tree.' };
  });
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '\\u0060\\u0060\\u0060agentdeck-watch\\n' + JSON.stringify(findings) + '\\n\\u0060\\u0060\\u0060', modelUsage: { 'claude-haiku-4-5': { inputTokens: 900, outputTokens: 200, cacheReadInputTokens: 4000, cacheCreationInputTokens: 100 } } }) + '\\n');
}, config.delayMs ?? 0));
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
  return config;
}

/** Разделы отчёта по меткам файла: отпечаток, атрибуты и тело. */
function sectionsOf(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
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

/** Остановить ровно запущенный здесь процесс — без обхода дерева (снёс однажды чужой стенд). */
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

function isolatedPath(bin) {
  const system = IS_WIN
    ? [
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        process.env.SystemRoot ?? 'C:\\Windows',
      ]
    : ['/usr/bin', '/bin'];
  return [bin, ...system].join(IS_WIN ? ';' : ':');
}

async function ui({ report, fakeConfig }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Подменённый 500 шага 7 браузер пишет в консоль сам — это не ошибка страницы.
    if (/status of 500/.test(text)) return;
    errors.push(text.slice(0, 200));
  });
  // Тела жалоб, ушедших со страницы: адрес — подсказка модели, где искать.
  const posted = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/watcher/reports')) {
      posted.push(request.postDataJSON());
    }
  });
  await bypassOnboarding(page, { language: 'ru', theme: 'light' });
  try {
    console.log('1. выключен');
    const off = await api('/watcher/reports', {
      method: 'POST',
      body: JSON.stringify({ text: BUG_OK, route: '/chat' }),
    });
    check(
      'жалоба при выключенном — 409 watcher-off',
      off.status === 409 && off.body?.messageCode === 'watcher-off',
      JSON.stringify(off),
    );

    await api('/watcher', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    await page.goto(`${WEB}/rules`, { waitUntil: 'domcontentloaded' });
    const onRow = page.locator('[data-watcher-indicator]:not([data-watcher-off])');
    await onRow.waitFor({ timeout: 20000 });
    await onRow.click();
    await page.waitForSelector('[data-watcher-popover]');

    console.log('2. форма и граница длины');
    const field = page.locator('[data-watcher-bug] textarea');
    const button = page.locator('[data-watcher-bug-check]');
    check('форма «Нашли баг сами?» в окне', (await field.count()) === 1);
    check('пустое поле — «Проверить» заперта', await button.isDisabled());
    await field.fill('ab');
    check('«ab» — заперта', await button.isDisabled());
    await field.fill('abc');
    check('«abc» — открыта', await button.isEnabled());

    console.log('3. подтверждённый баг');
    writeFileSync(fakeConfig, JSON.stringify({ delayMs: 2500 }));
    await field.fill(BUG_OK);
    await button.click();
    const checking = await page
      .waitForSelector('[data-watcher-check="checking"]', { timeout: 8000 })
      .catch(() => null);
    check('строка «проверяется» видна, пока модель думает', checking !== null);
    check('поле очищено после отправки', (await field.inputValue()) === '');
    check(
      'из окна жалоба уходит с адресом открытой страницы',
      posted.at(-1)?.route === '/rules',
      JSON.stringify(posted.at(-1)),
    );
    const confirmed = await page
      .waitForSelector('[data-watcher-check="confirmed"]', { timeout: 30000 })
      .catch(() => null);
    const confirmedText = confirmed ? await confirmed.textContent() : '';
    check(
      'строка «подтверждён — WR-n»',
      /подтверждён — WR-\d+/.test(confirmedText ?? ''),
      confirmedText ?? '',
    );
    const afterOk = sectionsOf(report);
    const userSection = afterOk.find((section) => section.body.includes(BUG_OK));
    check(
      'в отчёте раздел с текстом жалобы, источник «человек», подтверждён',
      Boolean(userSection) &&
        /человек/.test(userSection.body) &&
        userSection.attrs.verdict === 'confirmed',
      JSON.stringify(userSection?.attrs ?? afterOk.map((section) => section.attrs)),
    );

    console.log('4. неподтверждённый, отправлен Ctrl+Enter');
    writeFileSync(fakeConfig, JSON.stringify({ delayMs: 0 }));
    await field.fill(BUG_NO);
    await field.press('Control+Enter');
    const rejected = await page
      .waitForSelector('[data-watcher-check="rejected"]', { timeout: 30000 })
      .catch(() => null);
    const rejectedText = rejected ? await rejected.textContent() : '';
    check(
      'строка «по коду не подтвердился» с причиной модели',
      /по коду не подтвердился/.test(rejectedText ?? '') &&
        (rejectedText ?? '').includes(REJECT_REASON),
      rejectedText ?? '',
    );
    const afterNo = sectionsOf(report);
    check(
      'разделов в отчёте не прибавилось',
      afterNo.length === afterOk.length && !afterNo.some((s) => s.body.includes(BUG_NO)),
      `${afterOk.length} → ${afterNo.length}`,
    );

    console.log('5. задержанная отправка');
    await page.route('**/api/watcher/reports', async (route) => {
      await wait(1500);
      await route.continue();
    });
    await field.fill(BUG_SLOW);
    await button.click();
    await wait(400);
    check('пока запрос в полёте — кнопка заперта', await button.isDisabled());
    await page.waitForSelector('[data-watcher-check]:nth-child(1)', { timeout: 5000 });
    await until(async () => (await field.inputValue()) === '', 6);
    await page.unroute('**/api/watcher/reports');
    await until(
      async () => (await page.locator('[data-watcher-check="checking"]').count()) === 0,
      30,
    );
    check(
      'в окне три последние проверки',
      (await page.locator('[data-watcher-check]').count()) === 3,
    );
    await wait(500);
    await page
      .locator('[data-watcher-popover]')
      .screenshot({ path: join(SHOTS, 'popover_AFTER.png') });

    console.log('6. страница наблюдателя и отчёт');
    await page.locator('[data-watcher-open-page]').click();
    await page.waitForSelector('[data-watcher-page] [data-watcher-report]', { timeout: 15000 });
    await wait(800);
    check('адрес /watcher', new URL(page.url()).pathname === '/watcher', page.url());
    check('окно индикатора закрыто', (await page.locator('[data-watcher-popover]').count()) === 0);
    const paths = page.locator('[data-watcher-report-path]');
    check(
      'путь файла на странице один раз',
      (await paths.count()) === 1,
      String(await paths.count()),
    );
    const shownPath = await paths.first().textContent();
    check('путь файла на странице', shownPath === report, `${shownPath} / ${report}`);
    const fileSections = sectionsOf(report);
    const cards = page.locator('[data-watch-section]');
    check(
      'карточек столько же, сколько разделов в файле',
      (await cards.count()) === fileSections.length,
      `${await cards.count()} / ${fileSections.length}`,
    );
    await page.getByRole('button', { name: /^Подтверждённые/ }).click();
    const verdicts = await cards.evaluateAll((list) =>
      list.map((card) => card.getAttribute('data-watch-verdict')),
    );
    const confirmedInFile = fileSections.filter((s) => s.attrs.verdict === 'confirmed').length;
    check(
      'фильтр «Подтверждённые» — только подтверждённые',
      verdicts.length === confirmedInFile && verdicts.every((v) => v === 'confirmed'),
      JSON.stringify(verdicts),
    );
    await page.getByRole('button', { name: /^Замечания/ }).click();
    check(
      'пустой фильтр «Замечания» — «разделов нет»',
      (await cards.count()) === 0 &&
        (await page.getByText('В этом фильтре разделов нет.').count()) === 1,
    );
    await page.getByRole('button', { name: /^Все/ }).click();
    const userCard = cards.filter({ hasText: 'QA user bug' }).first();
    await userCard.locator('[data-watch-expand]').click();
    const body = await userCard.locator('[data-watch-body]').textContent();
    check(
      '«Подробнее» раскрывает тело раздела из файла',
      (body ?? '').includes('QA root cause') && (body ?? '').includes(BUG_OK),
      (body ?? '').slice(0, 200),
    );
    await page.screenshot({ path: join(SHOTS, 'report-page_AFTER.png'), fullPage: true });

    console.log('7. отказ и пустой отчёт');
    await page.route('**/api/watcher/report', (route) =>
      route.fulfill({ status: 500, json: { error: 'down' } }),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    const failed = await page
      .getByText('Не удалось прочитать отчёт')
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check('отказ сервера — карточка ошибки', failed);
    await page.screenshot({ path: join(SHOTS, 'report-error_AFTER.png') });
    await page.unroute('**/api/watcher/report');
    await page.getByRole('button', { name: 'Повторить' }).click();
    const back = await page
      .waitForSelector('[data-watch-section]', { timeout: 15000 })
      .catch(() => null);
    check('«Повторить» вернул отчёт', back !== null);
    await page.route('**/api/watcher/report', (route) =>
      route.fulfill({ json: { path: report, exists: false, sections: [] } }),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    const empty = await page
      .getByText('Отчёт пуст')
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('файла нет — «Отчёт пуст»', empty);
    await page.unroute('**/api/watcher/report');

    console.log('8. форма на странице');
    const pageForm = page.locator('[data-watcher-page] [data-watcher-bug]');
    await pageForm.waitFor({ timeout: 15000 });
    await pageForm.locator('textarea').fill(BUG_PAGE);
    await pageForm.locator('[data-watcher-bug-check]').click();
    await until(async () => (await pageForm.locator('[data-watcher-check]').count()) === 4, 15);
    check(
      'на странице видны все проверки, а не три',
      (await pageForm.locator('[data-watcher-check]').count()) === 4,
      String(await pageForm.locator('[data-watcher-check]').count()),
    );
    check(
      'со страницы наблюдателя жалоба уходит без адреса',
      posted.length > 0 && posted.at(-1)?.route === undefined,
      JSON.stringify(posted.at(-1)),
    );
    await until(
      async () => (await page.locator('[data-watcher-check="checking"]').count()) === 0,
      30,
    );
    await page
      .locator('[data-watcher-page]')
      .screenshot({ path: join(SHOTS, 'watcher-page_AFTER.png') });

    console.log('9. выключение');
    await page.locator('[data-watcher-stop]').click();
    const hint = await page
      .waitForSelector('[data-watcher-bug-off]', { timeout: 15000 })
      .catch(() => null);
    check('остановлен — на странице подсказка вместо формы', hint !== null);
    check(
      'остановлен — строка в боковой панели «выкл»',
      (await page.locator('[data-watcher-indicator][data-watcher-off]').count()) === 1,
    );
    const status = (await api('/watcher')).body;
    check(
      'выключен — проверок в статусе нет',
      status?.enabled === false && status?.checks === undefined,
      JSON.stringify(status?.checks),
    );
    check('ошибок консоли нет', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
}

async function main() {
  for (const port of [PANEL_PORT, WEB_PORT]) {
    if (await waitFor(`http://127.0.0.1:${port}/`, 1))
      throw new NotChecked(
        `порт ${port} занят чужим процессом — задайте WATCH_BUG_PANEL_PORT/WATCH_BUG_WEB_PORT.`,
      );
  }
  mkdirSync(SHOTS, { recursive: true });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-watcher-bug-qa-')));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fakeConfig = writeFakeClaude(bin, root);
  const report = join(root, 'report', 'WATCH-REPORT.md');
  const children = [];
  try {
    const env = makeEnv(join(root, 'main'), {
      PATH: isolatedPath(bin),
      AGENTDECK_WATCH_REPORT: report,
      AGENTDECK_WATCH_DEBOUNCE_MS: '300',
      AGENTDECK_WATCH_RUNS_PER_HOUR: '200',
    });
    children.push(
      spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/index.ts'], {
        cwd: join(REPO, 'apps/server'),
        env: { ...env, PORT: String(PANEL_PORT), WEB_PORT: String(WEB_PORT) },
        stdio: 'ignore',
        shell: false,
      }),
    );
    children.push(
      spawn(
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
      ),
    );
    if (!(await waitFor(`http://127.0.0.1:${PANEL_PORT}/api/system`, 40)))
      throw new NotChecked('одноразовая панель не поднялась.');
    if (!(await waitFor(WEB, 60))) throw new NotChecked('одноразовый фронт не поднялся.');
    console.log(`Панель :${PANEL_PORT}, фронт :${WEB_PORT}, отчёт ${report}\n`);
    await ui({ report, fakeConfig });
  } finally {
    for (const child of children) stopChild(child);
    await wait(600);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
}
console.log(failures === 0 ? '\nчисто' : `\nпровалов: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
