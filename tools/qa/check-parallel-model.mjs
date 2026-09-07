/**
 * Окно параллельного запуска: чем оно ведёт агентов и что говорит о цене.
 *
 * Проверяется ровно то, что нельзя увидеть модульным тестом: лестница ступеней
 * считается от потолка РАЗГОВОРА, понижение подписано и уезжает на сервер
 * отметкой `lowered`, дорогой запуск на потолке предупреждает о себе ДО нажатия,
 * а кнопка веера при пустом реестре гаснет, а не исчезает.
 *
 * Данные подменяются целиком: список проектов свой, а `POST /chat/send`
 * перехватывается в браузере и до сервера не доходит — настоящих агентов прогон
 * не заводит и от реестра проектов человека не зависит. Именно эта зависимость
 * и уронила прошлую, временную версию зонда: на машине без зарегистрированных
 * проектов кнопки веера просто не было.
 *
 * Запуск: `node tools/qa/check-parallel-model.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

/** Потолок разговора, от которого считается лестница. */
const CEILING = 'opus';
/** Ступень, на которую понижаем: она же обязана уехать в теле запроса. */
const LOWER_TO = 'sonnet';

const project = (name, path) => ({
  path,
  name,
  exists: true,
  lastActivity: '2026-09-07T10:00:00.000Z',
  chats: [],
});

// Три проекта — не для красоты: предупреждение о дорогом запуске начинается
// именно с третьего агента, и с двумя проверять было бы нечего.
const PROJECTS = [
  project('QA веер один', 'C:/qa-fan-one'),
  project('QA веер два', 'C:/qa-fan-two'),
  project('QA веер три', 'C:/qa-fan-three'),
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

// Реестр проектов подменяем изменяемым значением: первая фаза проверяет пустой
// реестр, вторая — тот же экран с проектами.
let projects = [];
const sent = [];

await page.route('**/api/chats/projects*', (route) => route.fulfill({ json: projects }));
await page.route('**/api/chats', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chat/send', async (route) => {
  sent.push(route.request().postDataJSON());
  await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
});

const openProjectsTab = async () => {
  await page.getByRole('tab', { name: 'Проекты' }).first().click();
  await page.waitForTimeout(600);
};

// --- Пустой реестр: кнопка обязана быть, но выключенной ------------------

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);
await openProjectsTab();

const fanButton = page.getByRole('button', { name: 'Запустить в нескольких' });
check((await fanButton.count()) === 1, 'при пустом реестре кнопка веера на месте');
check(await fanButton.first().isDisabled(), 'при пустом реестре кнопка выключена');

// --- Реестр с проектами: лестница, понижение, цена запуска ---------------

projects = PROJECTS;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

// Потолок разговора — модель в шапке. Пустое значение («как в настройках»)
// лестницы не задаёт, поэтому ставим известную.
const header = page.getByRole('combobox', { name: 'Модель' }).first();
const headerOptions = await header
  .locator('option')
  .evaluateAll((nodes) => nodes.map((node) => node.value));
check(headerOptions.includes('fable'), 'в выборе модели есть ступень fable');
await header.selectOption(CEILING);
await page.waitForTimeout(400);

await openProjectsTab();
check(!(await fanButton.first().isDisabled()), 'с проектами кнопка веера включена');
await fanButton.first().click();
await page.waitForTimeout(600);

const dialog = page.getByRole('dialog', { name: 'Запуск в нескольких проектах' });
check((await dialog.count()) > 0, 'окно параллельного запуска открылось');

const model = dialog.getByRole('combobox', { name: 'Модель всех прогонов веера' });
const effort = dialog.getByRole('combobox', { name: 'Глубина всех прогонов веера' });
check((await model.count()) === 1, 'выбор модели веера на месте');
check((await effort.count()) === 1, 'выбор глубины веера на месте');
check((await model.inputValue()) === CEILING, 'по умолчанию — потолок разговора');

const ladder = await model.locator('option').allInnerTexts();
check(ladder.join(',') === 'haiku,sonnet,opus', `ступени не выше потолка: ${ladder.join(',')}`);

check((await dialog.getByText('ниже потолка').count()) === 0, 'на потолке подписи о понижении нет');

// Правки: окно обязано открываться разрешёнными — как обычный чат.
check(
  (await dialog
    .getByRole('switch', { name: 'Разрешить правку файлов проекта' })
    .getAttribute('aria-checked')) === 'true',
  'правки по умолчанию разрешены',
);

// --- Цена запуска: предупреждение появляется с третьего агента -----------

const warning = dialog.getByText('самый дорогой запуск панели');
check((await warning.count()) === 0, 'без выбранных проектов предупреждения нет');

await dialog.getByRole('textbox', { name: 'Что сделать' }).fill('прогони линт');
const items = dialog.locator('div[class*="list"] button');
check((await items.count()) === PROJECTS.length, `в списке все проекты: ${await items.count()}`);

await items.nth(0).click();
await items.nth(1).click();
await page.waitForTimeout(300);
check((await warning.count()) === 0, 'на двух агентах предупреждения ещё нет');

await items.nth(2).click();
await page.waitForTimeout(300);
check((await warning.count()) === 1, 'на третьем агенте предупреждение появилось');

await model.selectOption(LOWER_TO);
await page.waitForTimeout(300);
check((await dialog.getByText('ниже потолка').count()) === 1, 'понижение подписано');
check((await warning.count()) === 0, 'понижение снимает предупреждение о цене');

// --- Что уезжает на сервер ----------------------------------------------

await dialog.getByRole('button', { name: /^Запустить в / }).click();
await page.waitForTimeout(1500);

check(sent.length === PROJECTS.length, `запросов ушло: ${sent.length}`);
check(
  sent.every((body) => body?.model === LOWER_TO),
  `во всех запросах ступень ${LOWER_TO}`,
);
check(
  sent.every((body) => body?.lowered === true),
  'во всех запросах отметка о понижении',
);
check(
  sent.every((body) => body?.allowEdits === true),
  'правки разрешены и в запросах',
);
check(
  new Set(sent.map((body) => body?.projectPath)).size === PROJECTS.length,
  'каждый запрос уехал в свой проект',
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Веер выбирает ступень и называет цену запуска' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
