/**
 * Проект при чужом активном CLI — в едином чате `/chat` (этап 11, W3-17a).
 *
 * Прежде при активном не-Claude провайдере раздел «Чат» показывал свой экран чужого CLI с
 * вкладкой «Проекты» всех провайдеров, а «Новый разговор здесь» уводил в `/core/chat`. Экран
 * снят: чат один, CLI — активный провайдер, проект открывается адресом `/chat?project=<каталог>`.
 * Здесь проверяется, что при активном Kimi:
 *   - `/chat?project=<каталог из списка>` открывает и делает активной вкладку этого проекта с его
 *     именем из списка проектов (тот же список, что у Claude: проекты, начатые с Claude, не
 *     пропадают), страница — чат `/chat`, композер на месте;
 *   - `/chat?project=<каталог вне списка>` — вкладка с последней частью пути;
 *   - прежнего экрана чужого CLI нет (`[data-provider-projects]`), к `/api/provider-chat/*`
 *     страница не обращается вовсе;
 *   - старый адрес `/core/chat?project=X&cli=kimi` приводит в `/chat?project=X` без `cli`;
 *   - отрицательный: `/chat` без `?project=` вкладку проекта не открывает.
 *
 * Настоящий CLI не запускается и настройки панели НЕ переключаются: активный провайдер и список
 * проектов подменяются на лету, любая запись (не GET) к API отвечает подменой — на диске ничего.
 *
 * Запуск: `node tools/qa/check-provider-projects.mjs` при поднятом `pnpm dev`.
 * `SHOTS=<каталог>` — снимки в светлой и тёмной теме. Код выхода: 0 — сходится, 1 — провал.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;

const PROVIDER = { providerId: 'kimi', providerName: 'Kimi Code', mode: 'cli' };
// Каталоги настоящие: страница проекта спрашивает о нём сервер, а несуществующий путь дал бы
// ошибки, к проверке не относящиеся.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWN = {
  path: REPO,
  name: 'work/my-project (Claude)',
  exists: true,
  lastActivity: '2026-10-05T10:00:00.000Z',
  chats: [],
};
const UNKNOWN = tmpdir();
const lastPart = (p) =>
  p
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1);
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

let bad = 0;
const check = (ok, text, why = '') => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok && why) console.log(`    ${why}`);
  if (!ok) bad += 1;
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Вкладки рабочего места из localStorage страницы. */
const workspaceOf = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('agentdeck:workspace') ?? 'null'));

/** Ждёт активную вкладку проекта с этим путём (до 15 с); отдаёт рабочее место. */
async function activeTab(page, path) {
  let ws = null;
  for (let i = 0; i < 30; i++) {
    ws = await workspaceOf(page);
    const tab = ws?.projectTabs?.find((t) => norm(t.path) === norm(path));
    if (tab && ws.activeTabId === tab.id) return { ws, tab };
    await page.waitForTimeout(500);
  }
  return { ws, tab: undefined };
}

const browser = await chromium.launch();

for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();

  /** Обращения к прежнему API чата чужого CLI — после W3-17a их быть не должно. */
  const legacy = [];
  /** Записи, перехваченные подменой (не дошли до сервера). */
  const writes = [];

  // Общая подмена первой: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему обработчику, так что
  // частные маршруты ниже её перекрывают. Запись к API не уходит на стенд ни при каком исходе.
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.continue();
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return json(route, {});
  });
  await page.route('**/api/settings', async (route) => {
    // Обход мастера (как `bypass-onboarding.mjs`) и активный провайдер — только в ответе этой
    // вкладке; запись настроек — подменой, сервер не меняется.
    if (route.request().method() !== 'GET') return json(route, {});
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    return route.fulfill({
      response,
      json: { ...body, provider: PROVIDER.providerId, onboardingDone: true },
    });
  });
  await page.route('**/api/provider-chat/**', (route) => {
    legacy.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return json(route, {});
  });
  await page.route('**/api/provider-runner', (route) => json(route, PROVIDER));
  await page.route('**/api/chats/projects', (route) => json(route, [KNOWN]));

  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const tag = `[${scheme}]`;

  // Отрицательный: без `?project=` вкладка проекта не открывается.
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1500);
  const bare = await workspaceOf(page);
  check(
    !(bare?.projectTabs ?? []).some((t) => norm(t.path) === norm(KNOWN.path)),
    `${tag} /chat без ?project= вкладку проекта не открыл`,
    JSON.stringify(bare),
  );

  // Каталог из списка проектов: вкладка с его именем, активна, страница — чат.
  await page.goto(`${BASE}/chat?project=${encodeURIComponent(KNOWN.path)}`, {
    waitUntil: 'domcontentloaded',
  });
  const known = await activeTab(page, KNOWN.path);
  check(
    Boolean(known.tab) && known.tab.name === KNOWN.name,
    `${tag} /chat?project=<каталог из списка> — активна вкладка «${known.tab?.name ?? '—'}»`,
    JSON.stringify(known.ws),
  );
  const tabShown = await page
    .getByText(KNOWN.name, { exact: true })
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(tabShown, `${tag} имя проекта из списка видно на экране`);
  check(
    new URL(page.url()).pathname === '/chat' &&
      (await page.locator('[data-provider-projects]').count()) === 0,
    `${tag} при активном Kimi открыт единый чат /chat, прежнего экрана чужого CLI нет`,
  );
  const composer = await page
    .locator('textarea[data-chat-input]')
    .first()
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check(composer, `${tag} композер единого чата на месте`);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `project-${scheme}.png`) });
  }

  // Каталог вне списка: имя — последняя часть пути.
  await page.goto(`${BASE}/chat?project=${encodeURIComponent(UNKNOWN)}`, {
    waitUntil: 'domcontentloaded',
  });
  const unknown = await activeTab(page, UNKNOWN);
  check(
    Boolean(unknown.tab) && unknown.tab.name === lastPart(UNKNOWN),
    `${tag} /chat?project=<каталог вне списка> — вкладка «${unknown.tab?.name ?? '—'}»`,
    JSON.stringify(unknown.ws),
  );

  // Старый адрес: `/core/chat?project=X&cli=kimi` → `/chat?project=X`, без cli.
  await page.goto(
    `${BASE}/core/chat?project=${encodeURIComponent(KNOWN.path)}&cli=${PROVIDER.providerId}`,
    { waitUntil: 'domcontentloaded' },
  );
  const moved = await page
    .waitForURL((u) => u.pathname === '/chat', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const url = new URL(page.url());
  check(
    moved && url.searchParams.get('project') === KNOWN.path && !url.searchParams.has('cli'),
    `${tag} /core/chat?project=X&cli=kimi → ${url.pathname}${decodeURIComponent(url.search)}`,
  );

  check(
    legacy.length === 0,
    `${tag} к /api/provider-chat/* страница не обращалась (${legacy.length})`,
    legacy.join(', '),
  );
  check(errors.length === 0, `${tag} ошибок в консоли нет${errors.length ? `: ${errors[0]}` : ''}`);
  if (writes.length) console.log(`  записи, ответенные подменой: ${writes.join(', ')}`);
  await context.close();
}

await browser.close();
console.log(bad === 0 ? 'чисто' : `провалов: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
