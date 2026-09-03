/**
 * Порядок вкладок проектов задаёт человек — и порядок обязан держаться.
 *
 * Прогон ведёт настоящую ленту вкладок в шапке чата: перетаскивает вкладку
 * мышью, двигает соседнюю с клавиатуры (Alt+←/→) и перезагружает страницу.
 * Проверяется ровно то, ради чего это делалось: новый порядок виден сразу,
 * переживает перезагрузку, домашняя вкладка остаётся первой, а перетаскивание
 * НЕ переключает разговор — иначе перестановка фоновой вкладки утаскивала бы
 * человека из того чата, в котором он сидит.
 *
 * Данные подменяются целиком: ни настоящих чатов, ни запущенных агентов прогон
 * не трогает, а порядок вкладок живёт в localStorage отдельного контекста
 * браузера и умирает вместе с ним.
 *
 * Запуск: `node tools/qa/check-tab-reorder.mjs` при поднятом `pnpm dev`.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const SHOTS = '.agent/screenshots/before-after/tab-reorder';
const TABS_LABEL = 'Рабочие пространства';

const PROJECTS = [
  { name: 'QA вкладка альфа', path: 'C:/qa-tab-alpha' },
  { name: 'QA вкладка бета', path: 'C:/qa-tab-beta' },
  { name: 'QA вкладка гамма', path: 'C:/qa-tab-gamma' },
];

/** Короткие имена для сверки порядка — по ним и опознаём вкладки на ленте. */
const [ALPHA, BETA, GAMMA] = PROJECTS.map((project) => project.name);

await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

/**
 * Закрытие вкладки стирает снимок окна кода этого проекта. Каталоги здесь
 * выдуманные, на диске их нет — такой путь сервер не принимает, и это свойство
 * прогона, а не панели: у настоящего проекта тот же запрос отвечает 200
 * (закреплено в project-files-routes.integration.test.ts).
 */
const EXPECTED_FAILURE = /\/api\/project-files\/view\?/;

const errors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // Сетевые отказы разбираем по ответам: в консоли от них остаётся строка без
  // адреса, по которой ожидаемое от настоящего не отличить.
  if (message.text().startsWith('Failed to load resource')) return;
  errors.push(message.text().slice(0, 200));
});
page.on('response', (response) => {
  if (response.status() < 400 || EXPECTED_FAILURE.test(response.url())) return;
  errors.push(`${response.status()} ${response.url().slice(0, 160)}`);
});

await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: PROJECTS.map((project) => ({
      path: project.path,
      name: project.name,
      exists: true,
      lastActivity: '2026-09-03T10:00:00.000Z',
      chats: [],
    })),
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const strip = () => page.getByRole('tablist', { name: TABS_LABEL });

/** Порядок вкладок на ленте — домашняя первая, дальше проекты. */
async function order() {
  const names = await strip().getByRole('tab').allInnerTexts();
  return names.map((name) => name.trim()).filter(Boolean);
}

async function activeTab() {
  const names = await strip().locator('[role="tab"][aria-selected="true"]').allInnerTexts();
  return names[0]?.trim() ?? '';
}

await page.goto(process.env.APP_URL ?? 'http://localhost:8888/chat');
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

// Открываем три проекта — вкладки встают в порядке открытия. Каждый раз
// возвращаемся в список проектов: открытый проект уводит колонку в свои чаты.
for (const project of PROJECTS) {
  // Открытый проект уводит колонку в свои чаты — список проектов живёт на
  // домашней вкладке, туда и возвращаемся перед каждым следующим.
  const home = strip().getByRole('tab', { name: 'Чаты', exact: true });
  if (await home.count()) {
    await home.click();
    await page.waitForTimeout(600);
  }
  await page.getByRole('tab', { name: 'Проекты' }).first().click();
  await page.waitForTimeout(700);
  await page
    .getByRole('button', { name: new RegExp(project.name) })
    .first()
    .click();
  await page.waitForTimeout(900);
}

check(
  JSON.stringify(await order()) === JSON.stringify(['Чаты', ALPHA, BETA, GAMMA]),
  'три проекта открылись вкладками в порядке открытия',
);
check((await activeTab()) === GAMMA, 'активна последняя открытая вкладка');
await strip().screenshot({ path: `${SHOTS}/strip_BEFORE.png` });

// Тащим НЕактивную вкладку в конец ленты: так видно и перестановку,
// и то, что разговор от перетаскивания не переключается.
const from = await strip().getByRole('tab', { name: ALPHA }).boundingBox();
const to = await strip().getByRole('tab', { name: GAMMA }).boundingBox();
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await page.mouse.down();
// Мелкими шагами: перестановка считается по пересечению середины соседа,
// один прыжок мышью framer не увидит.
for (let step = 1; step <= 12; step += 1) {
  const x = from.x + from.width / 2 + ((to.x + to.width - from.x - from.width / 2) * step) / 12;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.waitForTimeout(40);
}
await page.mouse.up();
await page.waitForTimeout(600);

check(
  JSON.stringify(await order()) === JSON.stringify(['Чаты', BETA, GAMMA, ALPHA]),
  'перетащенная вкладка встала в конец ленты',
);
check((await activeTab()) === GAMMA, 'перетаскивание не переключило разговор');

// Клавиатура: шаг вправо у средней вкладки.
await strip().getByRole('tab', { name: BETA }).focus();
await page.keyboard.press('Alt+ArrowRight');
await page.waitForTimeout(400);
check(
  JSON.stringify(await order()) === JSON.stringify(['Чаты', GAMMA, BETA, ALPHA]),
  'Alt+→ двигает вкладку на шаг вправо',
);

// У левого края шаг никуда не ведёт, а домашняя вкладка не пускает к себе.
await strip().getByRole('tab', { name: GAMMA }).focus();
await page.keyboard.press('Alt+ArrowLeft');
await page.waitForTimeout(400);
check(
  JSON.stringify(await order()) === JSON.stringify(['Чаты', GAMMA, BETA, ALPHA]),
  'у края ленты шаг ничего не меняет, домашняя вкладка остаётся первой',
);

await page.reload();
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
check(
  JSON.stringify(await order()) === JSON.stringify(['Чаты', GAMMA, BETA, ALPHA]),
  'порядок пережил перезагрузку страницы',
);
await strip().screenshot({ path: `${SHOTS}/strip_AFTER.png` });

// Крестик из порядка Tab убран (внутри tablist чужой кнопке не место), поэтому
// клавиатурное закрытие живёт на самой вкладке — и обязано работать.
await strip().getByRole('tab', { name: BETA }).focus();
await page.keyboard.press('Delete');
await page.waitForTimeout(600);
check(
  JSON.stringify(await order()) === JSON.stringify(['Чаты', GAMMA, ALPHA]),
  'Delete на вкладке закрывает её',
);
check(
  await page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab'),
  'после закрытия фокус остался на ленте, а не улетел в начало страницы',
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Порядок вкладок слушается и держится' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
