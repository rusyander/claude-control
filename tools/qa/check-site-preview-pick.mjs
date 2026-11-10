/**
 * Окно сайта в чате и выбор элемента (этап 12 ядра, V1+V2, P173, P174) — настоящая дорога:
 * одноразовая панель, своё ядро, настоящий claude из PATH против `packages/stub-model` (подменена
 * только модель). Сайт — поддельный dev-сервер `domains/site-preview/__fixtures__/dev-site.mjs`,
 * запущенный реестром запусков панели (`POST /api/project-runner/start`), как это делает человек.
 *
 * Что видно:
 *   - полоса «Сайт: имя» над лентой появляется у запущенного сайта; окно открывается справа,
 *     iframe идёт через прокси панели (другой порт, тот же 127.0.0.1), а не прямо на dev-сервер;
 *   - Tab с «Закрыть» уводит фокус в сайт — рамка окна обведена; Shift+Tab — обводка снята;
 *   - подделка выбора отвергнута: сообщение из iframe с чужим `nonce` и сообщение самой страницы
 *     панели с ВЕРНЫМ `nonce` (другое окно-источник) чипа не дают;
 *   - «Выбрать элемент» подсвечивает элемент; щелчок по второй из двух одинаковых кнопок даёт чип
 *     в поле ввода, а сайту щелчок не достаётся (счётчик сайта не растёт); выбор снят сам;
 *   - отправка: у модели одно сообщение — просьба человека и блок элемента: уникальный селектор
 *     (в сайте ровно один такой элемент), текст, разметка ≤ 4 КБ без вставленного секрета, адрес
 *     dev-сервера, а не прокси; чип после отправки снят;
 *   - Escape в сайте снимает выбор;
 *   - сайт остановлен — окно и полоса уходят сами.
 *
 * Запуск: `node tools/qa/check-site-preview-pick.mjs` (стенд свой, `pnpm dev` не нужен).
 * `SHOTS=<dir>` — кадры в обеих темах, `SHOT_TAG=BEFORE|AFTER` — суффикс кадра; при BEFORE
 * проверка снимает чат с запущенным сайтом и выходит (окна сайта в старом коде нет).
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHOTS = process.env.SHOTS || '';
const SHOT_TAG = process.env.SHOT_TAG || 'AFTER';
const SECRET = ['sk', 'plantedStandSecret0042'].join('-');
const FIXTURE = 'apps/server/src/domains/site-preview/__fixtures__/dev-site.mjs';

const { chromium } = await import('playwright');
const { REPO, runOnStand, NotChecked, wait } = await import('./throwaway-stand.mjs');
const { openProjectChat } = await import('./chat-walk.mjs');
const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');

const cliAt = (name) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
};

function flat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : (b?.text ?? flat(b?.content))))
    .filter(Boolean)
    .join('\n');
}
const wordsOf = (m) =>
  m?.role !== 'user'
    ? ''
    : Array.isArray(m.content)
      ? flat(m.content.filter((b) => b?.type !== 'tool_result'))
      : flat(m.content);

/** Модель чата: на «ход-pick» — короткий ответ; всё, что видела, — в трассу. */
const trace = [];
const stub = await startStubModel({
  script: (ctx) => {
    const messages = Array.isArray(ctx.request.body?.messages) ? ctx.request.body.messages : [];
    const words = messages.map(wordsOf).filter(Boolean);
    trace.push(...words);
    return { text: words.some((w) => w.includes('ход-pick')) ? 'выбор принят' : 'stub side reply' };
  },
});
const stubEnv = { ANTHROPIC_BASE_URL: stub.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };
const claude = cliAt('claude');
let site = '';

await runOnStand(
  {
    label: 'site-preview-pick',
    extraPath: claude ? [dirname(claude)] : [],
    env: stubEnv,
    core: true,
    seed: ({ root }) => {
      site = join(root, 'stand-site');
      mkdirSync(site, { recursive: true });
      copyFileSync(join(REPO, FIXTURE), join(site, 'dev-site.mjs'));
      writeFileSync(
        join(site, 'package.json'),
        `${JSON.stringify({ name: 'stand-site', private: true, scripts: { dev: 'node dev-site.mjs' } }, null, 2)}\n`,
      );
    },
  },
  async (stand, check) => {
    if (!claude) throw new NotChecked('claude нет в PATH — чат через ядро не проверен');
    seedClaudeEnv(stand);
    const browser = await chromium.launch();
    try {
      await scenario(stand, check, browser);
    } finally {
      await stand.api('/project-runner/stop', { method: 'POST', body: { path: site } });
      await browser.close();
      await stub.close();
    }
  },
);

/** Вход claude стенда — адрес заглушки в `env` личного settings.json стенда. */
function seedClaudeEnv(stand) {
  const path = join(stand.cfg, 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(
    path,
    `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
  );
}

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await probe()) return true;
    await wait(250);
  }
  return false;
}

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${SHOT_TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

/** Запущенная цель сайта по реестру стенда. */
async function siteRun(stand) {
  const runs = (await stand.api('/project-runner')).body;
  return (Array.isArray(runs) ? runs : []).find(
    (run) => run.projectPath.toLowerCase() === site.toLowerCase(),
  );
}

async function scenario(stand, check, browser) {
  const added = await stand.api('/projects', {
    method: 'POST',
    body: { path: site, name: 'stand-site' },
  });
  if (added.status >= 300) throw new Error(`проект не добавился: ${added.text}`);
  const started = await stand.api('/project-runner/start', {
    method: 'POST',
    body: { path: site },
  });
  check('реестр запусков принял сайт', started.status === 200, started.text);
  let run;
  await until(async () => {
    run = await siteRun(stand);
    return run?.status === 'running' && Boolean(run.url);
  }, 30);
  check(
    'сайт работает и назвал адрес',
    run?.status === 'running' && Boolean(run?.url),
    JSON.stringify(run),
  );
  const devOrigin = new URL(run.url).origin;

  const page = await openProjectChat(stand, browser, site, 'stand-site');
  const strip = page.locator('[data-site-open]');
  await strip.waitFor({ timeout: 20_000 }).catch(() => undefined);
  await shoot(page, 'chat-site-running');
  if (SHOT_TAG === 'BEFORE') {
    console.log(`Кадры «до»: ${SHOTS || '(SHOTS не задан)'}`);
    return;
  }
  check('полоса «Сайт: stand-site» над лентой', (await strip.count()) === 1);
  check('полоса называет адрес dev-сервера', (await strip.textContent())?.includes(run.url));

  // Открыть окно сайта: адрес прокси и nonce — из ответа сервера, iframe — через прокси.
  const opened = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith('/api/site-preview'),
  );
  await strip.click();
  const preview = await (await opened).json();
  const pane = page.locator('[data-site-preview]');
  await pane.waitFor({ timeout: 15_000 });
  const iframe = pane.locator('iframe');
  const src = await iframe.getAttribute('src');
  const proxyOrigin = new URL(src).origin;
  check(
    'iframe идёт через прокси панели на 127.0.0.1, а не прямо на dev-сервер',
    new URL(src).hostname === '127.0.0.1' && proxyOrigin !== devOrigin && src === preview.url,
    `${src} vs ${run.url}`,
  );
  check('полоса нажата, пока окно открыто', (await strip.getAttribute('aria-pressed')) === 'true');
  const frame = page.frameLocator('[data-site-preview] iframe');
  await frame.locator('button.buy').nth(1).waitFor({ timeout: 15_000 });
  const siteFrame = page.frames().find((f) => f.url().startsWith(proxyOrigin));
  check('в окне — страница сайта со скриптом выбора', Boolean(siteFrame));

  // Tab с «Закрыть» уводит фокус в сайт: рамка окна обведена (сайт с другого адреса, `:focus`
  // браузер ей не ставит — кольцо держит класс), Shift+Tab вернул фокус панели — обводки нет.
  const frameRing = () =>
    iframe.evaluate((el) => {
      const cs = getComputedStyle(el);
      return (
        document.activeElement === el && cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px'
      );
    });
  await pane.getByRole('button', { name: 'Закрыть окно сайта' }).focus();
  await page.keyboard.press('Tab');
  check('Tab в сайт — рамка окна обведена', await until(frameRing, 3));
  await page.keyboard.press('Shift+Tab');
  check(
    'Shift+Tab из сайта — обводка рамки снята',
    await until(async () => !(await frameRing()), 3),
  );

  // Подделки: чужой nonce изнутри сайта и верный nonce от другого окна (сама страница панели).
  const chips = page.locator('[data-composer-chip]');
  const forged = (nonce) => ({
    type: 'agentdeck:pick',
    nonce,
    selector: 'body > div.forged',
    tag: 'div',
    text: 'forged pick',
    outerHTML: '<div class="forged">forged pick</div>',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    url: 'http://127.0.0.1:1/',
  });
  await siteFrame.evaluate(
    (data) => window.parent.postMessage(data, '*'),
    forged('forged-nonce-0123456789'),
  );
  await page.evaluate((data) => window.postMessage(data, '*'), forged(preview.nonce));
  await wait(1500);
  check('подделка выбора (чужой nonce, чужое окно) чипа не дала', (await chips.count()) === 0);

  // Выбор второй из двух одинаковых кнопок.
  const pickButton = pane.getByRole('button', { name: 'Выбрать элемент' });
  await pickButton.click();
  check('«Выбрать элемент» нажата', (await pickButton.getAttribute('aria-pressed')) === 'true');
  const second = frame.locator('button.buy').nth(1);
  await second.hover();
  await wait(300);
  const boxShown = await siteFrame.evaluate(() => {
    const box = document.querySelector('[data-agentdeck-pick-box]');
    return Boolean(box) && box.style.display !== 'none';
  });
  check('наведение подсвечивает элемент в сайте', boxShown);
  await shoot(page, 'site-pick-hover');
  await second.click();
  check('выбор дал чип в поле ввода', await until(async () => (await chips.count()) === 1, 10));
  check(
    'чип подписан тегом и текстом элемента',
    (await chips.first().textContent())?.includes('<button> Pay for the order'),
  );
  check(
    'щелчок выбора сайту не достался (счётчик не вырос)',
    (await frame.locator('#clicks').textContent()) === 'clicks: 0',
  );
  check(
    'выбор снят сам после одного элемента',
    (await pane.getByRole('button', { name: 'Выбрать элемент' }).getAttribute('aria-pressed')) ===
      'false',
  );
  await shoot(page, 'chip-in-composer');

  // Отправка: просьба человека и блок элемента — одним сообщением.
  const input = page.locator('textarea[data-chat-input]');
  await input.fill('ход-pick: поправь эту кнопку');
  await input.press('Enter');
  check(
    'ход с выбором закончился ответом',
    await until(() => page.getByText('выбор принят').count(), 180),
  );
  const said = trace.find((w) => w.includes('ход-pick')) ?? '';
  const selector = /- селектор: (.+)/.exec(said)?.[1]?.trim() ?? '';
  const matches = selector
    ? await siteFrame.evaluate((s) => document.querySelectorAll(s).length, selector)
    : 0;
  check(
    'у модели — просьба и блок элемента одним сообщением',
    said.includes('Элемент со страницы сайта'),
    said.slice(0, 400),
  );
  check('селектор уникален: в сайте ровно один такой элемент', matches === 1, selector);
  check(
    'селектор ведёт ко второй кнопке',
    selector.length > 0 &&
      (await siteFrame.evaluate(
        (s) => document.querySelector(s) === document.querySelectorAll('button.buy')[1],
        selector,
      )),
  );
  check('текст элемента дошёл', said.includes('- текст: Pay for the order'));
  const html = said.split('```html\n')[1]?.split('\n```')[0] ?? '';
  check('разметка ≤ 4 КБ', html.length > 0 && html.length <= 4096, `длина ${html.length}`);
  check(
    'вставленный секрет до модели не дошёл',
    !said.includes(SECRET) && !trace.some((w) => w.includes(SECRET)),
  );
  check(
    `адрес — dev-сервера (${devOrigin}), не прокси`,
    said.includes(`- адрес: ${devOrigin}`) && !said.includes(proxyOrigin),
  );
  check('после отправки чип снят', (await chips.count()) === 0);

  // Escape внутри сайта снимает выбор.
  const pickAgain = pane.getByRole('button', { name: 'Выбрать элемент' });
  await pickAgain.click();
  await frame.locator('body').press('Escape');
  check(
    'Escape в сайте снимает выбор',
    await until(async () => (await pickAgain.getAttribute('aria-pressed')) === 'false', 5),
  );

  // Сайт остановлен — окно и полоса уходят сами.
  await stand.api('/project-runner/stop', { method: 'POST', body: { path: site } });
  check(
    'сайт остановлен — окно сайта закрылось',
    await until(async () => (await pane.count()) === 0, 20),
  );
  check('и полоса ушла', (await strip.count()) === 0);
  check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n'));
}
