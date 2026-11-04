/**
 * Проекты всех провайдеров в чате чужого CLI.
 *
 * При активном не-Claude провайдере раздел «Чат» показывает чат этого CLI, и его
 * список знал только собственные разговоры — проекты, начатые с Claude, из вида
 * пропадали. Здесь проверяется вкладка «Проекты»: каталоги всех провайдеров с
 * бейджами тех, кто в них работал, и новый разговор АКТИВНОГО провайдера в
 * каталоге проекта. Разговор панель больше не заводит (этап 10, F2c): кнопка
 * открывает чат ядра `/core/chat?cli=<активный>&project=<каталог>`, а
 * `POST /api/provider-chat/chats` не уходит вовсе. Каталог, которого больше нет,
 * не исчезает молча: кнопка погашена, причина написана рядом.
 *
 * Настоящий CLI не запускается и настройки панели НЕ переключаются: активный
 * провайдер и весь `/api/provider-chat/*` подменяются на лету; создание разговора
 * подмена отвергает 410, как настоящий сервер, — на диске ничего не появляется.
 *
 * Запуск: `node tools/qa/check-provider-projects.mjs` при поднятом `pnpm dev`.
 * `SHOTS=<каталог>` — снимки вкладки в светлой и тёмной теме.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;

const PROVIDER = { providerId: 'kimi', providerName: 'Kimi Code', mode: 'cli' };

const CLAUDE_ONLY = {
  path: 'C:/work/shop-front',
  name: 'work/shop-front',
  lastActivity: '2026-10-05T10:00:00.000Z',
  providers: [
    { id: 'claude', name: 'Claude Code', chatCount: 4, lastActivity: '2026-10-05T10:00:00.000Z' },
  ],
};
const GONE = {
  path: 'C:/work/old-api',
  name: 'work/old-api',
  lastActivity: '2026-09-20T10:00:00.000Z',
  providers: [
    { id: 'codex', name: 'Codex', chatCount: 1, lastActivity: '2026-09-20T10:00:00.000Z' },
    { id: 'claude', name: 'Claude Code', chatCount: 2, lastActivity: '2026-09-01T10:00:00.000Z' },
  ],
  startProblem: 'missing',
};

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) bad += 1;
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const browser = await chromium.launch();

for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await bypassOnboarding(page, { provider: PROVIDER.providerId });

  /** Попытки завести разговор панели — после переезда на ядро их быть не должно. */
  const posted = [];

  // Общая подмена первой: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему
  // обработчику, так что частные маршруты ниже её перекрывают. Без неё любой
  // неожиданный запрос ушёл бы на стенд с активным Claude и получил 400.
  await page.route('**/api/provider-chat/**', (route) => json(route, {}));
  await page.route('**/api/provider-runner', (route) => json(route, PROVIDER));
  await page.route('**/api/provider-chat/projects', (route) => json(route, [CLAUDE_ONLY, GONE]));
  await page.route('**/api/provider-chat/chats', async (route) => {
    if (route.request().method() !== 'POST') return json(route, []);
    posted.push(JSON.parse(route.request().postData() ?? '{}'));
    return json(route, { message: 'чат идёт через ядро', messageCode: 'provider-chat-core' }, 410);
  });

  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await page.waitForSelector('[data-provider-projects]', { timeout: 10_000 });

  const tag = `[${scheme}]`;
  const rows = page.locator('[data-project-path]');
  check((await rows.count()) === 2, `${tag} оба проекта в списке, исчезнувший тоже`);

  const claudeRow = page.locator(`[data-project-path="${CLAUDE_ONLY.path}"]`);
  const goneRow = page.locator(`[data-project-path="${GONE.path}"]`);
  check(
    (await claudeRow.locator('[data-provider-badge="claude"]').count()) === 1,
    `${tag} проект, где работал только Claude, виден в чате Kimi с бейджем Claude`,
  );
  check(
    (await claudeRow.locator('[data-provider-badge="claude"]').textContent())?.trim() ===
      'Claude Code',
    `${tag} бейдж называет провайдера`,
  );
  check(
    (await goneRow.locator('[data-provider-badge]').count()) === 2,
    `${tag} у проекта двух провайдеров два бейджа`,
  );

  const goneStart = goneRow.getByRole('button', { name: /Новый разговор Kimi Code/ });
  check(await goneStart.isDisabled(), `${tag} в исчезнувшем каталоге разговор не начать`);
  check(
    (await goneRow.locator('[data-project-problem="missing"]').textContent())?.includes(
      'Каталога больше нет',
    ) === true,
    `${tag} причина написана рядом с погашенной кнопкой`,
  );

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `projects-${scheme}.png`) });
  }

  const start = claudeRow.getByRole('button', {
    name: `Новый разговор Kimi Code в проекте ${CLAUDE_ONLY.name}`,
  });
  check(await start.isEnabled(), `${tag} в существующем каталоге кнопка активна`);
  // Ошибки консоли — до ухода на экран ядра: его запросы идут на стенд и к этой проверке не относятся.
  const errorsBefore = [...errors];
  await start.click();
  const moved = await page
    .waitForURL(/\/core\/chat/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const url = new URL(page.url());
  check(
    moved &&
      url.searchParams.get('cli') === PROVIDER.providerId &&
      url.searchParams.get('project') === CLAUDE_ONLY.path,
    `${tag} открыт чат ядра активного провайдера в каталоге проекта (${url.pathname}${decodeURIComponent(url.search)})`,
  );
  check(posted.length === 0, `${tag} разговор панели не заводился (POST: ${posted.length})`);

  if (SHOTS) await page.screenshot({ path: join(SHOTS, `started-${scheme}.png`) });

  check(
    errorsBefore.length === 0,
    `${tag} ошибок в консоли нет${errorsBefore.length ? `: ${errorsBefore[0]}` : ''}`,
  );
  await context.close();
}

await browser.close();
console.log(bad === 0 ? 'чисто' : `провалов: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
