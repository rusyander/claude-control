/**
 * Вкладки страниц разделов (`shared/ui/page-tabs` + `usePageTab`): защита
 * данных, паспорт среды, сравнение, плагины, скрипты, аналитика.
 *
 * Для каждой страницы: роли (tablist/tab/tabpanel, aria-selected, связь
 * вкладки с панелью), клик по каждой вкладке меняет адрес и панель, стрелки,
 * Home/End ходят по вкладкам с фокусом, перезагрузка с `?tab=` открывает ту же
 * вкладку, незнакомый `?tab=xyz` без памяти открывает первую, а без `?tab=`
 * открывается запомненная. Ничего не пишет — годится и на реальной
 * конфигурации. Нужен поднятый `pnpm dev`.
 *
 * Запуск: node tools/qa/check-page-tabs.mjs [dlp scripts …]
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';

/** Страница → ожидаемые id вкладок по порядку (у сравнения — разделы сервера). */
const PAGES = {
  '/dlp': { key: 'dlp', tabs: ['proxy', 'rules', 'check', 'journal', 'gate'] },
  '/portability': {
    key: 'portability',
    tabs: ['passport', 'transfer', 'subscription', 'probe', 'carry'],
  },
  '/compare': { key: 'compare', tabs: ['mcp', 'env', 'permissions', 'instructions'] },
  '/plugins': { key: 'plugins', tabs: ['installed', 'catalog', 'marketplaces', 'scaffold'] },
  '/scripts': { key: 'scripts', tabs: ['all', 'used', 'unused', 'test'] },
  '/analytics': {
    key: 'analytics',
    tabs: ['overview', 'breakdown', 'activity', 'sessions', 'live'],
  },
  // Без правил полосы нет вовсе, а правила стенда — настоящий CLAUDE.md
  // человека: список подменяется на время прогона, файлы не трогаются.
  '/rules': {
    key: 'rules',
    tabs: ['all', 'enabled', 'disabled'],
    stub: { url: '**/api/rules', body: stubRules() },
  },
};

function stubRules() {
  const rule = (order, title, isEnabled) => ({
    id: `qa-rule-${order}`,
    title,
    body: `Текст правила «${title}» для прогона вкладок.`,
    order,
    isEnabled,
    groupIds: [],
    scope: 'global',
  });
  return [
    rule(0, 'Отвечать по-русски', true),
    rule(1, 'Не коммитить сам', true),
    rule(2, 'Старое правило', false),
  ];
}

const only = process.argv.slice(2);
const problems = [];
let passed = 0;

const expect = (ok, name, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  ок  ${name}`);
  } else {
    problems.push(`${name}: ${detail}`);
    console.log(`  !!  ${name} — ${detail}`);
  }
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (error) => problems.push(`ошибка страницы: ${error.message}`));
await bypassOnboarding(page);

const selectedId = () =>
  page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('id');
const tabParam = () => new URL(page.url()).searchParams.get('tab');

async function open(path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'load' });
  await page.waitForSelector('[role="tablist"]', { timeout: 15000 });
  await page.waitForTimeout(400);
}

for (const [path, spec] of Object.entries(PAGES)) {
  // Имя без слеша тоже подходит: Git Bash переписывает `/dlp` в путь Windows.
  if (only.length > 0 && !only.some((arg) => arg === path || arg === spec.key)) continue;
  console.log(`\n${path}`);
  const idOf = (tab) => `${spec.key}-tab-${tab}`;
  if (spec.stub) {
    const { url, body } = spec.stub;
    await page.route(url, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: body }) : route.continue(),
    );
  }

  // Память чистая: первая вкладка по умолчанию.
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
  await page.evaluate((key) => localStorage.removeItem(`agentdeck.${key}.tab`), spec.key);
  await open(path);

  const ids = await page
    .locator('[role="tablist"] [role="tab"]')
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(
    JSON.stringify(ids) === JSON.stringify(spec.tabs.map(idOf)),
    'вкладки по порядку',
    JSON.stringify(ids),
  );
  expect(
    (await selectedId()) === idOf(spec.tabs[0]),
    'без адреса и памяти — первая',
    await selectedId(),
  );
  const label = await page.locator('[role="tablist"]').first().getAttribute('aria-label');
  expect(Boolean(label), 'у полосы есть доступное имя', String(label));
  const tabbable = await page.locator('[role="tablist"] [role="tab"][tabindex="0"]').count();
  expect(tabbable === 1, 'одна вкладка в порядке Tab (roving tabindex)', `${tabbable}`);

  // Клик по каждой вкладке: адрес, выбранная вкладка, панель, связанная с ней.
  for (const tab of spec.tabs) {
    await page.locator(`#${idOf(tab)}`).click();
    await page.waitForTimeout(250);
    const panel = page.locator('[role="tabpanel"]').first();
    const panelFor = await panel.getAttribute('aria-labelledby');
    const panelText = ((await panel.textContent()) ?? '').trim();
    expect(
      tabParam() === tab && (await selectedId()) === idOf(tab) && panelFor === idOf(tab),
      `клик «${tab}» → адрес, выбор, панель`,
      `tab=${tabParam()} selected=${await selectedId()} panel=${panelFor}`,
    );
    expect(panelText.length > 0, `панель «${tab}» не пуста`, 'пустая панель');
  }

  // Стрелки с фокусом: от последней вправо — на первую, End/Home — края.
  const last = spec.tabs[spec.tabs.length - 1];
  await page.locator(`#${idOf(last)}`).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const focused = () => page.evaluate(() => document.activeElement?.id);
  expect(
    (await selectedId()) === idOf(spec.tabs[0]) && (await focused()) === idOf(spec.tabs[0]),
    'стрелка вправо с последней — на первую, фокус следом',
    `${await selectedId()} / ${await focused()}`,
  );
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  expect(
    (await selectedId()) === idOf(last),
    'стрелка влево с первой — на последнюю',
    await selectedId(),
  );
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  expect((await selectedId()) === idOf(spec.tabs[0]), 'Home — первая', await selectedId());
  await page.keyboard.press('End');
  await page.waitForTimeout(200);
  expect((await selectedId()) === idOf(last), 'End — последняя', await selectedId());

  // Перезагрузка с `?tab=` — та же вкладка.
  const second = spec.tabs[1];
  await open(`${path}?tab=${second}`);
  expect(
    (await selectedId()) === idOf(second),
    `перезагрузка с ?tab=${second}`,
    await selectedId(),
  );

  // Без `?tab=` — запомненная (последняя открытая — `second`).
  await open(path);
  expect(
    (await selectedId()) === idOf(second),
    'без ?tab= — запомненная вкладка',
    await selectedId(),
  );

  // Незнакомое значение без памяти — первая, не пустой экран.
  await page.evaluate((key) => localStorage.removeItem(`agentdeck.${key}.tab`), spec.key);
  await open(`${path}?tab=xyz`);
  expect(
    (await selectedId()) === idOf(spec.tabs[0]),
    '?tab=xyz — первая вкладка',
    await selectedId(),
  );

  // Уход со страницы в другой раздел со своим `?tab=`: пока новый раздел грузится,
  // старая страница ещё смонтирована и видит ЧУЖОЙ адрес — она не должна
  // переписывать в нём вкладку своей (было: /settings?tab=models → tab=proxy).
  // Переход — через историю приложения, без перезагрузки, как у «Назад» и ссылок
  // агента. Модуль раздела настроек придержан на 1,5 с: окно, в котором старая
  // страница видит чужой адрес, есть всегда, а не только на медленном стенде.
  await open(path);
  const holdSettings = async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  };
  await page.route('**/src/pages/Settings/**', holdSettings);
  await page.evaluate(() => {
    window.history.pushState(null, '', '/settings?tab=models');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForTimeout(3000);
  await page.unroute('**/src/pages/Settings/**', holdSettings);
  expect(
    new URL(page.url()).pathname === '/settings' && tabParam() === 'models',
    'переход в /settings?tab=models — вкладка чужого раздела цела',
    page.url(),
  );
  await page.goBack();
  await page.waitForTimeout(800);
  expect(
    new URL(page.url()).pathname === path && tabParam() !== 'models',
    `«Назад» в ${path} — своя вкладка`,
    page.url(),
  );
}

await browser.close();
console.log(`\nпроверок пройдено: ${passed}, проблем: ${problems.length}`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(problems.length > 0 ? 1 : 0);
