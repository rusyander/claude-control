/**
 * Хаб родителя: группа, остановленная на доставке, читается списком, а не
 * красной стеной через «; » (владелец, 23.10.2026).
 *
 * 1. Остановленную на доставке группу сама панель уже не двигает (F-23): заголовок
 *    «Доставка остановлена — 9 пунктов», строка действия — по коду причины
 *    первым пунктом `deliveryMissing` (напоминание не сдвинуло / потолок
 *    напоминаний / разбор на усиленной модели не сдвинул): продолжить группу
 *    словом в её чате. Сама причина пунктом списка не идёт; «панель доводит
 *    сама — от вас ничего не нужно» и «решение за вами» не пишутся.
 * 2. Пункты — по строке: имя сита/блока выделено, затем что не так и что
 *    сделать; после четырёх — «ещё N», нажатие раскрывает остальные и НЕ уводит
 *    в чат группы (кнопка стоит над растянутой кнопкой карточки).
 * 3. Без `deliveryMissing` (сервер постарше) — пункты из текста причины,
 *    строка действия общая: «сама она не продолжит».
 * 4. Свёрнутый раздел «Не хватает для MR» у остановленной группы не дублирует список.
 * 5. Строка человеку — только у пунктов, которые агенту нельзя (мерж MR,
 *    разрушительная операция, нет доступа), и называет само действие; общей
 *    строки действия тогда нет.
 *
 * Данные подменяются целиком, ВСЕ запросы `/api` — тоже: живой сервер прогон не
 * трогает. Фронт — свой Vite копии на свободном порту с мёртвым API_PORT.
 *
 * Запуск: `APP_URL=http://127.0.0.1:<порт> node tools/qa/check-hub-delivery-stop.mjs`;
 * `SHOTS=<папка>` — снимки карточек, `QA_THEME=dark` — тёмная тема.
 */
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA доставка', path: 'C:/qa-delivery-project' };

const PARENT = 'qa-delivery-parent';
const KID_LIST = 'qa-delivery-list';
const KID_TEXT = 'qa-delivery-text';

// Пункты в новом виде «<сито/блок>: <что не так> — <что сделать>» и в старом.
const MISSING = [
  'сито «интеграция»: нет записи прогона интеграционных тестов — прогоните их через блок «Тесты» копии',
  'сито «чужие −»: удалены строки вне задачи в src/api/client.ts — верните их или объясните в MR',
  'сито contract-by-request не пройдено: поле limit не описано в контракте — добавьте его в packages/contracts',
  'сито «покрытие»: порог веток 78% ниже закреплённого 80% — допишите тесты на новую ветку',
  'сито «тексты»: ключ chat.limit есть только в ru — добавьте en',
  'блок «Тесты» копии: 2 задетых кейса без зелёного прогона — прогоните группу «чат»',
  'незакоммиченные правки: src/a.ts, src/b.ts',
  'ветка feature/limits не отправлена на удалённый (или отстаёт от HEAD копии)',
  'нет MR с головой копии — откройте MR из ветки feature/limits',
];
const REASON = {
  stalled:
    'напоминание 2 ничего не изменило: та же голова ветки и те же пробелы — посмотрите, что держит группу, и продолжите её словом',
  'nudge-cap':
    'панель напомнила группе 6 раз — это потолок напоминаний; группа двигалась, но не дошла — продолжите её словом',
  'escalation-stalled':
    'разбор доставки на усиленной модели тоже ничего не изменил (после 4 напоминаний): та же голова ветки и те же пробелы — нужен человек',
};
// Строка действия, которую человек видит у каждого вида остановки.
const ACTION = {
  stalled:
    /^Напоминание ничего не сдвинуло, панель больше не напоминает\..*продолжите её словом в чате группы/,
  'nudge-cap': /^Потолок напоминаний: .*Продолжите её словом в чате группы/,
  'escalation-stalled': /^Разбор на усиленной модели тоже ничего не сдвинул — нужен человек\./,
  none: /^Группа остановлена, сама она не продолжит\. Продолжите её словом в чате группы/,
};
const TEXT_ONLY = [
  'сито «интеграция»: нет записи прогона — прогоните интеграционные тесты',
  'незакоммиченные правки: src/c.ts',
  'ветка feature/export не отправлена на удалённый',
];

// Пункты, которые агенту нельзя, вперемешку с обычным.
const HUMAN_ONLY = [
  'сито «тексты»: ключ chat.limit есть только в ru — добавьте en',
  'MR готов, проверки зелёные — нужен мерж MR',
  'интеграция: нет токена доступа к трекеру — добавьте токен в настройки проекта',
];
const HUMAN_MR = 'https://forge.example.com/proj/app/-/merge_requests/123';

const GROUPS = [
  { index: 0, title: 'Лимиты', branch: 'feature/limits', chatId: KID_LIST },
  { index: 1, title: 'Экспорт', branch: 'feature/export', chatId: KID_TEXT },
  { index: 2, title: 'Импорт', branch: 'feature/import', chatId: 'qa-delivery-human' },
  { index: 3, title: 'Отчёты', branch: 'feature/reports', chatId: 'qa-delivery-cap' },
  { index: 4, title: 'Поиск', branch: 'feature/search', chatId: 'qa-delivery-escalated' },
];
const copyOf = (group) => `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`;

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:05:00.000Z',
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.stage ? { stage: extra.stage } : {}),
  ...(extra.groupTitle ? { groupTitle: extra.groupTitle } : {}),
  ...(extra.groupIndex !== undefined ? { groupIndex: extra.groupIndex } : {}),
  ...(extra.branch ? { branch: extra.branch } : {}),
});

const chats = [
  chat(PARENT, { title: 'Пачка задач' }),
  ...GROUPS.map((group) =>
    chat(group.chatId, {
      title: `Работа группы «${group.title}»`,
      parentId: PARENT,
      stage: 'work',
      groupTitle: group.title,
      groupIndex: group.index,
      branch: group.branch,
      projectPath: copyOf(group),
    }),
  ),
];

const base = (group) => ({
  index: group.index,
  title: group.title,
  branch: group.branch,
  after: [],
  chatId: group.chatId,
  path: copyOf(group),
  deliver: true,
  seated: true,
});

// Как пишет сервер: причина остановки — первым пунктом `deliveryMissing` с кодом,
// за ней пробелы; `error` — склейка всех пунктов.
const stalled = (group, kind, nudges) => {
  const missing = [REASON[kind], ...MISSING];
  return {
    ...base(group),
    status: 'failed',
    error: `доставка не доведена: ${missing.join('; ')}`,
    errorCode: 'split-delivery-incomplete',
    errorParams: { missing: missing.join('; ') },
    deliveryMissing: missing,
    deliveryMissingCodes: [
      { messageCode: `split-delivery-${kind}`, params: { nudges } },
      ...MISSING.map(() => null),
    ],
    deliveryNudges: nudges,
  };
};

const split = {
  parentChatId: PARENT,
  order: [0, 1, 2, 3, 4],
  groups: [
    stalled(GROUPS[0], 'stalled', 2),
    // Сервер постарше: пунктов отдельно нет, копия убрана — продолжать негде.
    {
      ...base(GROUPS[1]),
      status: 'failed',
      error: `доставка не доведена: ${TEXT_ONLY.join('; ')}`,
      cleaned: { at: '2026-10-23T11:00:00.000Z', branch: 'kept' },
    },
    // Мерж и доступ — только человеку; остальное доводит панель.
    {
      ...base(GROUPS[2]),
      status: 'failed',
      mr: HUMAN_MR,
      error: `доставка не доведена: ${HUMAN_ONLY.join('; ')}`,
      deliveryMissing: HUMAN_ONLY,
    },
    stalled(GROUPS[3], 'nudge-cap', 6),
    stalled(GROUPS[4], 'escalation-stalled', 4),
  ],
};

const SETTINGS = {
  onboardingDone: true,
  chatModel: 'claude-opus-5',
  chatEffort: 'high',
  language: 'ru',
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(process.env.QA_WIDTH ?? 1300), height: 1600 },
  ...(process.env.QA_THEME ? { colorScheme: process.env.QA_THEME } : {}),
});

const errors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Запросы мимо подмен отвечают 404 нарочно — живого сервера за ними нет.
  if (/404 \(Not Found\)|Failed to load resource/.test(text)) return;
  errors.push(text.slice(0, 200));
});

// Подмена всего API первым маршрутом: Playwright отдаёт запрос ПОСЛЕДНЕМУ
// подходящему обработчику, так что точные подмены ниже её перекрывают.
// Предикат, а не `**/api/**`: под маску попадали и модули Vite `/src/shared/api/*`.
await page.route(
  (url) => url.pathname.startsWith('/api/'),
  (route) => route.fulfill({ status: 404, json: { error: 'qa stub' } }),
);
await page.route('**/api/settings', (route) => route.fulfill({ json: SETTINGS }));
// Без расположения конфига мастер онбординга закрывает страницу окном «не загрузилась».
await page.route('**/api/location', (route) =>
  route.fulfill({ json: { path: 'C:/qa-home/.claude', isValid: true, source: 'default' } }),
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
        lastActivity: '2026-10-23T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: chats }));
await page.route('**/api/chat/*/tree', (route) =>
  route.fulfill({
    json: {
      root: PARENT,
      running: 0,
      split,
      nodes: chats
        .filter((item) => item.parentId)
        .map((item) => ({
          chatId: item.id,
          aliases: [],
          parentChatId: PARENT,
          title: item.title,
          running: false,
        })),
    },
  }),
);
await page.route('**/api/chats/*/messages*', (route) =>
  route.fulfill({
    json: {
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Разделил задачи на две группы.' }],
          timestamp: '2026-10-23T10:02:00.000Z',
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

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};
const shot = async (name, locator) => {
  if (!process.env.SHOTS) return;
  await (locator ?? page.locator('[data-child-hub]'))
    .screenshot({ path: `${process.env.SHOTS}/${name}.png` })
    .catch(() => page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }));
};

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);
await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1500);
await page
  .getByRole('button', { name: /Пачка задач/ })
  .first()
  .click();
await page.waitForTimeout(2000);

const hub = page.locator('[data-child-hub]');
check((await hub.count()) === 1, 'сводка групп у родителя показана');
// Карточка — по названию группы: `data-group-index` стоит на кнопках, а не на ней.
const cardOf = (index) => hub.locator('[data-hub-row]').filter({ hasText: GROUPS[index].title });
// Отсутствующий элемент — быстрый «ПЛОХО», а не полминуты ожидания на каждой проверке.
page.setDefaultTimeout(5000);
await shot('01-hub');
await shot('02-card-list', cardOf(0));

// 1. Заголовок и кто действует.
const stop = cardOf(0).locator('[data-hub-delivery-stop]');
check(
  (await stop.count()) === 1,
  'у остановленной на доставке группы — блок «доставка не доведена»',
);
const head =
  (await stop
    .locator('[data-hub-delivery-head]')
    .textContent()
    .catch(() => '')) ?? '';
check(
  /^Доставка остановлена — 9 пунктов$/.test(head.trim()),
  `заголовок со счётом пробелов (причина не в счёте): «${head}»`,
);
check(
  (await stop.getAttribute('data-delivery-mode').catch(() => null)) === 'continue',
  'группа сама не продолжит — режим «продолжить»',
);
check(
  (await stop.getAttribute('data-delivery-stall').catch(() => null)) === 'stalled',
  'вид остановки — по коду причины split-delivery-stalled',
);
const whoOf = async (block) =>
  (
    (await block
      .locator('[data-hub-delivery-who]')
      .textContent()
      .catch(() => '')) ?? ''
  ).trim();
const who = await whoOf(stop);
check(ACTION.stalled.test(who), `строка действия «напоминание не сдвинуло»: «${who}»`);
const blockText = (await stop.textContent().catch(() => '')) ?? '';
check(
  !/доводит сама|ничего не нужно|продолжит сама|решени/i.test(blockText),
  'в блоке нет ни «доводит сама — от вас ничего не нужно», ни «решение за вами»',
);
check(
  !/ничего не изменило/.test(
    (await stop.locator('[data-hub-delivery-item]').allTextContents()).join(' '),
  ),
  'причина остановки пунктом списка не идёт',
);
check(
  (await stop.locator('[data-hub-delivery-human]').count()) === 0,
  'строк человеку нет — пунктов только для человека нет',
);

// 2. Пункты по строке, свёрнуто после четырёх.
const items = stop.locator('[data-hub-delivery-item]');
check((await items.count()) === 4, `видно четыре пункта до «ещё»: ${await items.count()}`);
const firstName = items.first().locator('[data-hub-delivery-name]');
check(
  ((await firstName.textContent().catch(() => '')) ?? '') === 'сито «интеграция»',
  'имя сита — отдельным выделенным словом',
);
const weight = Number(
  await firstName.evaluate((el) => getComputedStyle(el).fontWeight).catch(() => 0),
);
check(weight >= 600, `имя сита — полужирным: ${weight}`);
const firstTodo = items.first().locator('[data-hub-delivery-todo]');
check(
  /прогоните их через блок «Тесты» копии/.test(
    (await firstTodo.textContent().catch(() => '')) ?? '',
  ),
  '«что сделать» — своей частью пункта',
);
const wall = (await cardOf(0).allTextContents()).join(' ');
check(!/; сито/.test(wall), 'красной стены через «; » нет');
const more = stop.locator('[data-hub-delivery-more]');
check(/ещё 5/.test((await more.textContent().catch(() => '')) ?? ''), 'свёрнутые пункты — «ещё 5»');
check(
  (await cardOf(0).locator('[data-hub-delivery-missing]').count()) === 0,
  'раздел «Не хватает для MR» у остановленной группы не повторяет список',
);
if ((await more.count()) === 1) {
  await more.click();
  await page.waitForTimeout(500);
}
check((await hub.count()) === 1, 'нажатие «ещё» не увело в чат группы');
check((await items.count()) === 9, `после «ещё» — все девять пунктов: ${await items.count()}`);
await shot('03-card-expanded', cardOf(0));

// 3. Пункты из текста причины; копия убрана — человека всё равно не зовут.
const fallback = cardOf(1).locator('[data-hub-delivery-stop]');
const fallbackHead =
  (await fallback
    .locator('[data-hub-delivery-head]')
    .textContent()
    .catch(() => '')) ?? '';
check(/— 3 пункта/.test(fallbackHead), `без deliveryMissing пункты из текста: «${fallbackHead}»`);
check(
  !/решени|доводит сама|ничего не нужно/i.test(
    (await fallback.textContent().catch(() => '')) ?? '',
  ),
  'копия убрана — ни «решение за вами», ни «доводит сама»',
);
const fallbackWho = await whoOf(fallback);
check(ACTION.none.test(fallbackWho), `без кода причины — общая строка действия: «${fallbackWho}»`);
await shot('04-card-text-only', cardOf(1));

// 5. Только для человека: мерж MR и доступ — строками с действием.
const human = cardOf(2).locator('[data-hub-delivery-stop]');
check(
  (await human.getAttribute('data-delivery-mode').catch(() => null)) === 'human',
  'есть пункт только для человека — режим «человек»',
);
const humanHead =
  (await human
    .locator('[data-hub-delivery-head]')
    .textContent()
    .catch(() => '')) ?? '';
check(
  /^Доставка остановлена — 1 пункт$/.test(humanHead.trim()),
  `остальное — пунктом остановки: «${humanHead}»`,
);
check(
  (await human.locator('[data-hub-delivery-who]').count()) === 0,
  'пункты человека сами называют действие — общей строки нет',
);
const merge =
  (await human
    .locator('[data-hub-delivery-human="merge"]')
    .textContent()
    .catch(() => '')) ?? '';
check(merge === 'Нужен мерж MR !123', `мерж — с номером MR: «${merge}»`);
const access =
  (await human
    .locator('[data-hub-delivery-human="credentials"]')
    .textContent()
    .catch(() => '')) ?? '';
check(
  access === 'Нужен доступ: добавьте токен в настройки проекта',
  `доступ — точным действием: «${access}»`,
);
check(
  !/решени/i.test((await human.textContent().catch(() => '')) ?? ''),
  'строки человеку без слова «решение»',
);
await shot('05-card-human-only', cardOf(2));

for (const [index, kind, name] of [
  [3, 'nudge-cap', '06-card-nudge-cap'],
  [4, 'escalation-stalled', '07-card-escalation-stalled'],
]) {
  const block = cardOf(index).locator('[data-hub-delivery-stop]');
  const line = await whoOf(block);
  check(ACTION[kind].test(line), `строка действия «${kind}»: «${line}»`);
  check(
    (await block.getAttribute('data-delivery-stall').catch(() => null)) === kind,
    `вид остановки — по коду split-delivery-${kind}`,
  );
  const blockHead =
    (await block
      .locator('[data-hub-delivery-head]')
      .textContent()
      .catch(() => '')) ?? '';
  check(
    /^Доставка остановлена — 9 пунктов$/.test(blockHead.trim()),
    `${kind}: заголовок без причины в счёте: «${blockHead}»`,
  );
  await shot(name, cardOf(index));
}

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
await browser.close();
process.exit(bad === 0 ? 0 : 1);
