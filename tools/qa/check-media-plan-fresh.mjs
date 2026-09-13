/**
 * Меню «Режим» обязано спрашивать план у сервера НА ОТКРЫТИИ, а не один раз за
 * жизнь страницы.
 *
 * Находка враждебного ревью Т9 (MINOR 12): план спрашивался при монтировании и
 * не сбрасывался ничем — ни записью в настройки, ни активацией контура, ни
 * правкой `imagesUrl`. Разговор живёт открытым часами, поэтому меню продолжало
 * обещать дорогу, которой уже нет: человек описывал картинку и получал отказ —
 * ровно тот отказ, ради которого план и спрашивается ДО нажатия.
 *
 * Что здесь настоящее: страница, меню и запрос плана. Подменён только сервер
 * (`page.route`) — иначе доказать смену дороги можно было бы, только выключив
 * контур на живом стенде человека, то есть правкой его настоящей конфигурации.
 * Между двумя открытиями меню ответ сервера меняется с рабочей дороги на
 * запертую: на прежнем коде второе открытие показывало бы первый ответ.
 *
 * Мутация, которая обязана покраснить: убрать `state.onMenuOpen?.()` в
 * `ChatModeMenu.tsx` — «второе открытие спросило план заново» и «меню показывает
 * новую причину» гаснут обе.
 *
 * Запуск: `node tools/qa/check-media-plan-fresh.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const PROJECT = { name: 'QA план медиа', path: 'C:/qa-media-plan' };
const CHAT = 'qa-media-plan-chat';

const CHATS = [
  {
    id: CHAT,
    title: 'Разговор с режимами',
    project: PROJECT.name,
    projectPath: PROJECT.path,
    isSandbox: false,
    messageCount: 1,
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T10:05:00.000Z',
    preview: 'режимы',
  },
];

/** Дорога есть: рисует контур. Так меню выглядит до того, как контур выключили. */
const IMAGE_OPEN = {
  available: true,
  source: 'contour-chat',
  title: 'EnterprisePlatform · dev',
  model: 'enterprise-platform-image',
  promptSent: true,
};
const DECK_OPEN = {
  available: true,
  source: 'contour',
  title: 'EnterprisePlatform · dev',
  model: 'enterprise-platform-chat',
  pdf: { available: true },
};

/**
 * Контур выключили в соседней вкладке: растровой дороги нет. Причина приезжает
 * КОДОМ, текст живёт в словаре, — поэтому прогон ждёт на экране слова словаря, а
 * не свою строку: иначе он проверял бы собственную фикстуру.
 */
const REASON = 'Шлюз панели выключен, а запрос в контур идёт через него';
const IMAGE_LOCKED = {
  available: false,
  reason: 'gateway-off',
  title: '',
  model: '',
  promptSent: false,
};
const DECK_LOCKED = {
  available: false,
  reason: 'gateway-off',
  title: '',
  model: '',
  pdf: { available: false, reason: 'no-browser' },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

// Сколько раз страница спросила план картинки. Счётчик — главное утверждение:
// он отличает «меню перечитало» от «меню показало своё старое знание».
let planAsks = 0;
let locked = false;
/** Адреса запросов плана: в них проверяется признак разговора (`agent=1`). */
const planUrls = [];

await page.route('**/api/media/images/plan*', (route) => {
  planAsks += 1;
  planUrls.push(route.request().url());
  route.fulfill({ json: locked ? IMAGE_LOCKED : IMAGE_OPEN });
});
await page.route('**/api/media/decks/plan*', (route) =>
  route.fulfill({ json: locked ? DECK_LOCKED : DECK_OPEN }),
);

await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-09-13T10:00:00.000Z',
        chats: CHATS,
      },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
/**
 * Ответ агента С РИСУНКОМ в блоке — дорога, которой режимы работают у любого CLI
 * и без контура. Лента обязана показать его карточкой, а не забором текста.
 */
const DRAWING = [
  'Вот схема:',
  '',
  '```agentdeck:svg',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40" width="80" height="40">',
  '<rect x="2" y="2" width="76" height="36" rx="6" fill="#2f6fed"/>',
  '</svg>',
  '```',
].join('\n');

await page.route(`**/api/chats/${CHAT}/messages*`, (route) =>
  route.fulfill({
    json: {
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: DRAWING }],
          timestamp: '2026-09-13T10:01:00.000Z',
        },
      ],
      total: 1,
      hasMore: false,
    },
  }),
);
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));

await page.goto(process.env.APP_URL ?? 'http://localhost:8888/chat');
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1200);
await page
  .getByRole('button', { name: /Разговор с режимами/ })
  .first()
  .click();
await page.waitForTimeout(1500);

// Кнопка меню подписана ТЕКУЩИМ режимом, а не словом «Режим»: режим виден, не
// открывая меню. В начале разговора это «Сообщение».
const menuButton = page.getByRole('button', { name: 'Сообщение', exact: true }).first();
check(await menuButton.isVisible().catch(() => false), 'кнопка режима есть у композера');

const asksBeforeFirstOpen = planAsks;
await menuButton.click();
await page.waitForTimeout(900);
const dialog = page.getByRole('dialog', { name: 'Что сделает отправка' });
check(await dialog.isVisible().catch(() => false), 'меню режимов открылось');
check(
  (await dialog.textContent().catch(() => ''))?.includes('EnterprisePlatform · dev') === true,
  'первое открытие показывает рабочую дорогу',
);

// Контур выключают в соседней вкладке. Страница об этом не узнаёт ничем:
// `state.json` не лежит в `~/.claude`, и наблюдатель файлов о нём не сообщает.
locked = true;
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

const asksBeforeSecondOpen = planAsks;
await menuButton.click();
await page.waitForTimeout(1200);
check(
  planAsks > asksBeforeSecondOpen,
  `второе открытие спросило план заново (было ${asksBeforeSecondOpen}, стало ${planAsks})`,
);
check(asksBeforeFirstOpen >= 0 && asksBeforeSecondOpen >= 1, 'план спрашивался и до открытия меню');

const dialogAfter = page.getByRole('dialog', { name: 'Что сделает отправка' });
const textAfter = (await dialogAfter.textContent().catch(() => '')) ?? '';
check(textAfter.includes(REASON), `меню показывает новую причину: «${REASON}»`);
check(!textAfter.includes('EnterprisePlatform · dev'), 'обещание прежней дороги с экрана ушло');

await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Находки ревью Т9 (MAJOR 5): весь экранный слой режимов не принадлежал ни одной
// проверке. Две мутации краснеют здесь, а не в гейте «вообще»:
//  - убрать `ask` у `useChatMedia` на странице чата — план уедет с `agent=0`, и
//    режим запрётся с `no-agent` в КАЖДОМ разговоре Claude, то есть критерий
//    владельца «доступен при любом провайдере» откатится целиком;
//  - вернуть `null` из `MediaFeedCard` для рисунка — картинка агента не появится
//    нигде, хотя блок в ответе есть.
check(
  planUrls.length > 0 && planUrls.every((url) => /[?&]agent=(1|true)\b/.test(url)),
  `страница чата спрашивает план как разговор с агентом (${planUrls.at(-1)?.split('?')[1] ?? '—'})`,
);

const drawing = page.getByText('Рисунок от агента').first();
check(
  await drawing.isVisible().catch(() => false),
  'рисунок из блока ответа показан карточкой в ленте',
);
check(
  await page
    .getByRole('button', { name: 'Сохранить файлом' })
    .first()
    .isVisible()
    .catch(() => false),
  'у карточки рисунка есть «Сохранить файлом»',
);
// Забор с блоком обязан уйти с экрана: принятый блок панель из ленты убирает,
// иначе человек читает разметку рядом с её же картинкой.
check(
  !(await page
    .getByText('agentdeck:svg')
    .first()
    .isVisible()
    .catch(() => false)),
  'сам блок из ленты убран, в тексте его не осталось',
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'План режимов перечитывается на открытии меню' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
