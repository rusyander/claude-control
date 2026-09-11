/**
 * Прогон раздела «Контур»: пустой экран, мастер из четырёх шагов, карточка,
 * матрица возможностей, список «Применён к» и журнал с точечным откатом.
 *
 * Весь API раздела подменяется здесь же. Причина не в удобстве: живого контура
 * нет ни на одном стенде, а проверка, которая зависит от чужой корпоративной
 * платформы, не проходит ни у кого, кроме автора. Заглушка задаёт ровно то, что
 * панель обязана показать, — и проверка сверяет экран с ней.
 *
 * Что здесь заперто, кроме разметки:
 *   1. ключ не появляется в открытом виде НИКОГДА, включая момент сразу после
 *      ввода: ни в поле, ни в разметке страницы;
 *   2. значки компромиссов приходят ДАННЫМИ — подпись, которую заглушка не
 *      прислала, на экране не появляется;
 *   3. режим «обязательно» не выбрать, не увидев, что будет при выключенной
 *      панели;
 *   4. прочерк в «Применён к» стоит с причиной, а не молча;
 *   5. ход, не попавший в сессию агента, назван вслух: молчание здесь человек
 *      заметил бы только по «забывшему» агенту.
 *
 * Запуск: `node tools/qa/check-platform.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SECRET = 'sk-корпоративный-ключ-проверки-4f21';

const CAPABILITIES = [
  {
    id: 'models',
    state: 'yes',
    detail: 'список сужен правами ключа',
    evidence: 'answer',
    count: 14,
  },
  {
    id: 'embeddings',
    state: 'yes',
    detail: 'модели эмбеддингов в списке ключа',
    evidence: 'answer',
  },
  {
    id: 'knowledge',
    state: 'indirect',
    detail: 'через владельца ключа, отдельного маршрута нет',
    evidence: 'platform',
    compromise: 'kb-via-owner',
  },
  {
    id: 'client-tools',
    state: 'no',
    detail: 'публичный API не принимает описания инструментов',
    evidence: 'platform',
    compromise: 'no-client-tools',
  },
];

const PROBE = {
  outcome: 'ok',
  reachable: true,
  url: 'https://api.dev.example.ru/v1/models',
  status: 200,
  detail: 'список моделей получен',
  models: ['gpt-4o', 'claude-sonnet-4-5'],
  capabilities: CAPABILITIES,
  limits: { nonStreamTimeoutSec: 120, managedContext: true },
  notes: [],
  compromises: ['kb-via-owner', 'no-client-tools'],
  checkedAt: new Date().toISOString(),
};

const PLATFORM = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 100,
  capabilities: ['models', 'embeddings', 'knowledge'],
  targets: ['assistant', 'claude'],
  projectPaths: [],
  agents: [{ id: '0f4b2a10-77c3-4d1e-9f0a-2b6c8d5e1a33', title: 'Юрист компании' }],
  budgetSince: '',
  caCertPath: '',
};

/**
 * Расход и бюджет (Т8). Две величины и они РАЗНЫЕ: внутренняя единица самого
 * контура (по ней ключ упирается в бюджет) и деньги по нашему прайсу. Модель
 * компании в прайсе Anthropic не значится — её токены в деньги не переведены и
 * названы отдельно, поэтому в дне ниже деньги меньше единицы, а не равны ей.
 */
const SPEND_DAYS = [
  {
    day: '2026-09-09',
    requests: 4,
    promptTokens: 1_000_000,
    completionTokens: 200_000,
    totalTokens: 1_200_000,
    money: { usd: 3.6, pricedTokens: 1_200_000, unpricedTokens: 0, unpricedModels: [] },
  },
  {
    day: '2026-09-10',
    requests: 9,
    promptTokens: 4_000_000,
    completionTokens: 1_000_000,
    totalTokens: 5_000_000,
    money: {
      usd: 7.2,
      pricedTokens: 2_400_000,
      unpricedTokens: 2_600_000,
      unpricedModels: ['enterprise-platform-corp-l'],
    },
  },
];

/** Итог за период бюджета: сумма дней выше — так его и считает сервер. */
const PERIOD_SPEND = {
  day: '',
  requests: 13,
  promptTokens: 5_000_000,
  completionTokens: 1_200_000,
  totalTokens: 6_200_000,
  money: {
    usd: 10.8,
    pricedTokens: 3_600_000,
    unpricedTokens: 2_600_000,
    unpricedModels: ['enterprise-platform-corp-l'],
  },
};

/** Когда контур ответил 402. Дата в прошлом — карточка обязана сказать «когда». */
const EXHAUSTED_AT = new Date(Date.now() - 90 * 60 * 1000).toISOString();

const budgetOf = (patch = {}) => ({
  spentUsd: 62,
  budgetUsd: 100,
  share: 0.62,
  tracked: true,
  overEstimate: false,
  nearLimit: false,
  exhausted: false,
  ...patch,
});

/** Карточка контура так, как её отдаёт сервер: настройка, ключ маской, расход. */
const cardOf = (patch = {}) => ({
  platform: PLATFORM,
  hasToken: true,
  maskedToken: 'sk-…4f21',
  health: PROBE,
  budget: budgetOf(),
  periodSpend: PERIOD_SPEND,
  ...patch,
});

/**
 * Ответ агента и его сессия. Ответ настоящий, а `sessionRecorded: false` —
 * та самая дыра, о которой панель обязана сказать вслух: ход не попал в
 * переписку, и следующий вопрос агент прочитает без него.
 */
const AGENT_ANSWER = {
  outcome: 'ok',
  detail: 'агент ответил за 12 с',
  text: 'Договор подряда с физлицом оформляется актом.',
  agentId: '0f4b2a10-77c3-4d1e-9f0a-2b6c8d5e1a33',
  sessionRecorded: false,
  status: 200,
  checkedAt: new Date().toISOString(),
};

const AGENT_SESSION = {
  sessionId: '',
  agentIds: ['0f4b2a10-77c3-4d1e-9f0a-2b6c8d5e1a33'],
  messages: [
    { role: 'user', content: 'Как оформить договор подряда?' },
    { role: 'assistant', content: 'Договор подряда с физлицом оформляется актом.' },
  ],
  empty: false,
};

const target = (patch) => ({
  targetId: 'claude',
  title: 'Claude Code',
  supported: true,
  filePath: '/home/u/.claude/settings.json',
  plan: [{ key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:5179/enterprise-platform-dev' }],
  conflicts: [],
  applied: false,
  ...patch,
});

const planOf = (applied) => ({
  platformId: 'enterprise-platform-dev',
  profileId: 'contour-enterprise-platform-dev',
  baseUrl: 'http://127.0.0.1:5179/enterprise-platform-dev/v1',
  rootUrl: 'http://127.0.0.1:5179/enterprise-platform-dev',
  ready: true,
  targets: [
    target({ targetId: 'assistant', title: 'Ассистент панели', filePath: '', applied }),
    target({ applied, ...(applied ? { appliedAt: new Date().toISOString() } : {}) }),
    target({ targetId: 'goose', title: 'Goose', supported: false, reason: 'no_env_section' }),
    target({ targetId: 'gemini', title: 'Gemini', supported: false, reason: 'gateway_dialect' }),
  ],
});

const GATEWAY = {
  settings: { enabled: true, port: 5179, forceStream: true },
  status: {
    running: true,
    address: 'http://127.0.0.1:5179',
    port: 5179,
    requestedPort: 5179,
    requests: 42,
    failures: 0,
    routes: [],
    usage: [
      {
        platformId: 'enterprise-platform-dev',
        requests: 42,
        promptTokens: 3_000_000,
        completionTokens: 3_200_000,
        totalTokens: 6_200_000,
        at: new Date().toISOString(),
      },
    ],
    events: [],
    compromises: [],
  },
};

/**
 * Сводка проверок контура. Сначала её НЕТ вовсе — так отвечает сервер старее
 * фронта, так же приходит ответ из кэша; страница обязана это пережить и ничего
 * о проверках не утверждать. Появляется по ходу прогона.
 */
let gatewayViolations;

/**
 * Текст, на котором «сработали» проверки. Он ОТРАВЛЯЕТ заглушку: лежит в следе
 * запроса, который панель получает вместе со сводкой. Проверка «его нет на
 * экране» имеет смысл только тогда, когда он вообще был в ответе сервера, —
 * иначе она зелена независимо от того, что рисует страница.
 */
const CHECKED_TEXT = 'мой паспорт 4017 № 123456';

const row = (patch) => ({
  name: 'pii-detector',
  count: 4,
  lastAt: new Date().toISOString(),
  actions: ['masked'],
  platformIds: ['enterprise-platform-dev'],
  ...patch,
});

const VIOLATIONS = {
  rows: [
    row({}),
    row({ name: 'secrets', count: 2, actions: ['blocked'] }),
    row({ name: 'toxicity', count: 1, actions: ['interrupted'] }),
    // Контур назвал проверку и не сказал, что сделал: пустое место рядом с
    // такой строкой читается как «сработала и пропустила».
    row({ name: 'prompt-injection', count: 1, actions: [] }),
  ],
  total: 8,
  maskedUnnamed: 2,
  blockedUnnamed: 1,
  interruptedUnnamed: 0,
  since: new Date(Date.now() - 3_600_000).toISOString(),
};

/** След запроса — с текстом внутри. На экране его быть не должно нигде. */
const POISONED_EVENT = {
  at: new Date().toISOString(),
  platformId: 'enterprise-platform-dev',
  path: '/enterprise-platform-dev/v1/chat/completions',
  dialect: 'openai-compat',
  status: 400,
  stages: [],
  summarized: false,
  violations: ['pii-detector'],
  masked: true,
  blocked: true,
  interrupted: false,
  unknownFrames: [],
  lost: [],
  totalTokens: 0,
  error: `Проверки контента контура остановили запрос: ${CHECKED_TEXT}`,
};

const gatewayInfo = () => ({
  ...GATEWAY,
  status: {
    ...GATEWAY.status,
    ...(gatewayViolations
      ? { violations: gatewayViolations, events: [POISONED_EVENT] }
      : { events: [] }),
  },
});

/** Что заглушка отдаёт списком. Меняется по ходу прогона. */
let platforms = [];
/** Ответил ли контур «бюджет исчерпан»: это состояние снимает сама страница. */
let exhausted = false;
const spendInfo = () => ({
  platformId: PLATFORM.id,
  budgetSince: '2026-09-09',
  period: PERIOD_SPEND,
  total: PERIOD_SPEND,
  days: SPEND_DAYS,
  budget: budgetOf(exhausted ? { exhausted: true, exhaustedAt: EXHAUSTED_AT } : {}),
});
/** Состояние переходника MCP: его переключает сама страница. */
let bridged = false;
const posted = [];

/**
 * Где ключ вообще появлялся в запросах панели — `МЕТОД путь.поле`.
 *
 * Проверка «ключа нет на экране» сама по себе зелена всегда: заглушка ключ не
 * возвращает, а страницу между вводом и показом перезагружают. Поэтому смотрим
 * туда, где ключ ЕСТЬ, — в исходящие запросы: он вправе уехать ровно один раз и
 * ровно в своём поле `token` (там сервер кладёт его в шифрованное хранилище).
 * Тот же ключ внутри `settings` осел бы в `state.json` открытым текстом и уехал
 * бы экспортом настроек на другую машину.
 */
const secretSightings = [];
const noteSecret = (method, path, body) => {
  if (body === null || typeof body !== 'object') return;
  for (const [key, value] of Object.entries(body)) {
    if (JSON.stringify(value ?? null).includes(SECRET))
      secretSightings.push(`${method} ${path}.${key}`);
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await bypassOnboarding(page);

// Один обработчик на весь раздел: порядок срабатывания нескольких перехватов
// зависит от порядка регистрации, и разбирать адрес внутри честнее, чем
// полагаться на него.
await page.route('**/api/platforms**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api\/platforms\/?/, '');
  const method = request.method();
  const json = (body) => route.fulfill({ json: body });

  try {
    noteSecret(method, path, request.postDataJSON());
  } catch {
    // Тело не JSON — панель такими запросами ключ не носит.
  }

  if (path === 'gateway') return json(gatewayInfo());
  if (path === 'gateway/restart') return json(gatewayInfo());
  if (path === '') return json({ platforms });

  // Переходник MCP — ручка не про конкретный контур, поэтому разбирается до
  // того, как адрес делится на «контур/действие».
  if (path === 'mcp/connect') {
    if (method === 'POST') bridged = true;
    if (method === 'DELETE') bridged = false;
    return json({
      name: 'enterprise-platform-контур',
      connected: bridged,
      ...(method === 'DELETE' ? { removed: true } : {}),
    });
  }

  const [, tail, rest] = path.split('/');
  if (tail === 'agents') {
    if (method === 'POST' && rest === 'ask') {
      posted.push({ kind: 'ask', body: request.postDataJSON() });
      return json(AGENT_ANSWER);
    }
    if (method === 'DELETE') {
      posted.push({ kind: 'session-reset', body: path });
      return route.fulfill({ status: 204, body: '' });
    }
    return json({ ...AGENT_SESSION, sessionId: path.split('/')[3] ?? '' });
  }
  if (method === 'PUT' && !tail) {
    posted.push({ kind: 'save', body: request.postDataJSON() });
    return json({ platform: PLATFORM, hasToken: true, maskedToken: 'sk-…4f21', health: PROBE });
  }
  if (method === 'GET' && tail === 'spend') return json(spendInfo());
  if (method === 'DELETE' && tail === 'spend' && rest === 'exhausted') {
    posted.push({ kind: 'clear-exhausted', body: path });
    exhausted = false;
    return json({ cleared: true, ...spendInfo() });
  }
  if (method === 'POST' && tail === 'check') return json(PROBE);
  if (method === 'GET' && tail === 'apply') return json(planOf(platforms.length > 0));
  if (method === 'POST' && tail === 'apply') {
    posted.push({ kind: 'apply', body: request.postDataJSON() });
    return json({ applied: [{ targetId: 'claude', filePath: '', written: [] }], skipped: [] });
  }
  if (method === 'POST' && tail === 'disable') {
    posted.push({ kind: 'disable', body: request.postDataJSON() });
    return json({
      entries: [{ targetId: 'claude', filePath: '', outcome: 'restored' }],
      profileRemoved: false,
    });
  }
  return json({ platforms });
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const finish = async (code, message) => {
  console.log(message);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await browser.close();
  process.exit(code);
};

const open = async () => {
  await page.goto(`${BASE}/platform`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1200);
};

// --- Пустой экран ---------------------------------------------------------

await open();
const emptyText = await page.locator('body').innerText();
check(emptyText.includes('Контур не подключён'), 'пустое состояние названо');
check(
  emptyText.includes('одному ключу') || emptyText.includes('суженным правами ключа'),
  'пустое состояние объясняет пользу, а не сообщает «нет данных»',
);
check(
  (await page.getByRole('button', { name: 'Подключить контур' }).count()) > 0,
  'из пустого экрана есть дорога в мастер',
);

// --- Мастер: адрес --------------------------------------------------------

await page.getByRole('button', { name: 'Подключить контур' }).first().click();
await page.waitForTimeout(400);
check((await page.getByRole('dialog').count()) > 0, 'мастер открылся');

await page.getByLabel('Название').fill('EnterprisePlatform · dev');
await page.getByLabel('Адрес API').fill('https://api.dev.example.ru');
const idValue = await page.getByLabel('Идентификатор').inputValue();
check(idValue === 'enterprise-platform-dev', `идентификатор собран из имени: ${idValue}`);

await page.getByRole('button', { name: 'Проверить связь' }).click();
await page.waitForTimeout(600);
check(
  (await page.locator('[role="dialog"]').innerText()).includes('отвечает'),
  'проба показала ответ контура',
);
check(
  posted.some((item) => item.kind === 'save'),
  'проверка сохранила черновик — иначе серверу нечего проверять',
);

// --- Мастер: ключ ---------------------------------------------------------

await page.getByRole('button', { name: 'Далее' }).click();
await page.waitForTimeout(300);
const keyField = page.getByLabel('Ключ контура');
check((await keyField.getAttribute('type')) === 'password', 'поле ключа скрывает ввод');
await keyField.fill(SECRET);
await page.waitForTimeout(200);

const html = await page.content();
const visible = await page.locator('body').innerText();
check(!html.includes(SECRET), 'ключ не попал в разметку страницы сразу после ввода');
check(!visible.includes(SECRET), 'ключ не виден на экране');

// --- Мастер: что доступно -------------------------------------------------

await page.getByRole('button', { name: 'Далее' }).click();
await page.waitForTimeout(900);
const stepThree = await page.locator('[role="dialog"]').innerText();
check(stepThree.includes('Знания компании'), 'матрица заполнена ответом контура');
check(stepThree.includes('косвенно'), 'состояние «косвенно» названо словом, а не только цветом');
check(
  stepThree.includes('не объявлено') === false,
  'заглушка не прислала «не объявлено» — его и нет',
);
check(
  (await page.locator('[data-compromise-mark="kb-via-owner"]').count()) > 0,
  'подпись из ответа API стоит рядом со строкой, которую объясняет',
);
check(
  (await page.locator('[data-compromise-mark="probe-guess"]').count()) === 0,
  'подписи, которой в ответе не было, на экране нет',
);

// --- Мастер: где применять ------------------------------------------------

await page.getByRole('button', { name: 'Далее' }).click();
await page.waitForTimeout(700);
const stepFour = await page.locator('[role="dialog"]').innerText();
check(stepFour.includes('Ассистент панели'), 'ассистент в списке целей');
check(stepFour.includes('рекомендуется'), 'ассистент помечен рекомендованным');
check(
  stepFour.includes('у этого CLI нет файла переменных окружения'),
  'у прочерка стоит причина, а не молчание',
);
check(
  stepFour.includes('говорит на диалекте, которого шлюз не понимает'),
  'вторая причина прочерка отличается от первой',
);
check(
  (await page.locator('[data-compromise-mark="cli-no-endpoint"]').count()) > 0,
  'прочерк подписан',
);
check(
  stepFour.includes('останется без модели'),
  'режим «обязательно» показывает, что будет при выключенной панели',
);

const assistantBox = page.locator('[role="dialog"] input[type="checkbox"]').first();
check(await assistantBox.isChecked(), 'ассистент предвыбран');

await page.getByRole('button', { name: 'Готово' }).click();
await page.waitForTimeout(800);
const applyCall = posted.find((item) => item.kind === 'apply');
check(Boolean(applyCall), 'применение отправлено');
check(
  applyCall?.body?.targets?.includes('assistant') === true,
  `в применение уехали выбранные цели: ${JSON.stringify(applyCall?.body?.targets ?? [])}`,
);

// Ключ уже проехал мастер целиком. Первая строка — про саму пробу: если она
// пуста, красной не станет и вторая, а вторая тут и есть смысл.
check(secretSightings.length > 0, 'ключ дошёл до сервера — иначе проверка ниже пуста');
check(
  secretSightings.every((place) => place.endsWith('.token')),
  `ключ ехал только своим полем: ${secretSightings.join(', ')}`,
);

// --- Карточка настроенного контура ----------------------------------------

platforms = [cardOf()];
await open();

const card = await page.locator('body').innerText();
check(card.includes('EnterprisePlatform · dev'), 'карточка контура на экране');
check(card.includes('на связи'), 'состояние названо словом');
check(card.includes('sk-…4f21'), 'ключ показан маской');
check(card.includes('Применён к'), 'список «Применён к» на месте');
check(card.includes('расход ≈ 62.00 из 100 $'), 'расход считается по единице контура');
check(card.includes('Журнал применения'), 'журнал применения на месте');

// --- Расход: величина одна, и она названа оценкой (Т8, правка 10.09.2026) ---

// Величина ОДНА: деньги по нашему прайсу. Второй, «внутренней единицы контура»
// (токены × 0.00001 $), больше нет — такой формулы у контура не существует, он
// тарифицирует по ценам своего реестра. Число под её подписью выдавало бы наше
// за чужое, поэтому проверяем и то, что оценка на месте, и то, что выдуманной
// цифры рядом не появилось.
check(card.includes('расход ≈ 62.00 из 100 $'), 'расход назван оценкой и сопоставлен с бюджетом');
check(
  !card.includes('внутренн') && !card.includes('стоило бы'),
  'ни следа «внутренней единицы контура» — этой формулы у контура нет',
);
check(
  card.includes('в оценку не вошли, цены нет у: enterprise-platform-corp-l'),
  'модель без цены названа поимённо и объявлена не вошедшей в оценку',
);
// День начала периода человек не вводил — панель говорит «с начала учёта», а не
// придумывает дату за него: выбирать, какой расход не показывать, не ей.
check(card.includes('с начала учёта'), 'без введённой даты период назван словами');
check(!card.includes('бюджет исчерпан'), 'без отказа контура про исчерпание речи нет');

// Полоса бюджета — не только цвет: скринридер обязан услышать величины, а не
// проценты под подписью «Бюджет ключа, $». Найдено враждебным ревью Т8.
const meter = page.getByRole('meter');
check((await meter.count()) === 1, 'полоса бюджета объявлена как измеритель');
check(
  ((await meter.getAttribute('aria-valuetext')) ?? '').includes('62.00 из 100 $'),
  `полоса называет величины словами: ${await meter.getAttribute('aria-valuetext')}`,
);
check(
  ((await meter.getAttribute('aria-label')) ?? '') !== 'Бюджет ключа, $',
  'у полосы своя подпись, а не подпись поля ввода: проценты — не доллары',
);

// Обещанное предупреждение на 85 % было ТОЛЬКО цветом полосы: шесть пикселей,
// сменившие оттенок, не видит ни человек на другой странице, ни скринридер.
platforms = [cardOf({ budget: budgetOf({ spentUsd: 88, share: 0.88, nearLimit: true }) })];
await open();
const nearText = await page.locator('body').innerText();
check(
  nearText.includes('израсходовано 88 % бюджета'),
  'подход к бюджету сказан словами, а не только цветом полосы',
);
check(!nearText.includes('бюджет исчерпан'), 'подход к бюджету не выдаётся за отказ контура');

// Отказ 402 — факт, но НЕ про бюджет ключа: контур отдаёт его с дневного лимита
// пользователя, месячного команды или месячного инстанса и называет уровень в
// теле. Бюджет самого ключа он отклоняет кодом 401, неотличимым от отозванного
// ключа. Карточка обязана назвать уровень, иначе она сообщает, что кончилось не
// то, что кончилось.
platforms = [
  cardOf({
    platform: { ...PLATFORM, budgetSince: '2026-09-09' },
    budget: budgetOf({
      exhausted: true,
      exhaustedAt: EXHAUSTED_AT,
      exhaustedLevel: 'user_daily',
    }),
  }),
];
exhausted = true;
await open();
const spentText = await page.locator('body').innerText();
check(
  spentText.includes('период с 2026-09-09'),
  'введённый день начала периода назван на карточке',
);
check(
  spentText.includes('контур отказал по лимиту «user_daily»'),
  'отказ назван словами и с УРОВНЕМ лимита, а не полосой у края',
);
check(
  spentText.includes('это не бюджет ключа'),
  'сказано прямо, что кончился не бюджет ключа: иначе человек чинил бы не то',
);
check(
  spentText.includes('назад') || spentText.includes('час'),
  `сказано, КОГДА контур отказал: ${spentText.match(/отказал.{0,50}/)?.[0] ?? '—'}`,
);

const extended = page.getByRole('button', { name: 'Отметку снять' });
check((await extended.count()) === 1, 'снять отметку можно кнопкой, и только ею');
await extended.click();
await page.waitForTimeout(600);
check(
  posted.some((item) => item.kind === 'clear-exhausted'),
  'снятие отметки уехало на сервер, а не осталось на экране',
);

// Сервер СТАРЕЕ ФРОНТА расхода не присылает вовсе. Карточка обязана промолчать,
// а не рухнуть, утащив за собой весь раздел: до Т8 этих полей не было.
platforms = [{ platform: PLATFORM, hasToken: true, maskedToken: 'sk-…4f21', health: PROBE }];
await open();
const older = await page.locator('body').innerText();
check(older.includes('EnterprisePlatform · dev'), 'без расхода в ответе карточка всё равно рисуется');
check(older.includes('расход ≈ 0.00 $'), 'расход без данных — ноль с оговоркой, а не пусто');

platforms = [cardOf()];
exhausted = false;
await open();

// --- Проверки контура: показ, а не вызов ----------------------------------

// Сводки в ответе шлюза сейчас НЕТ — так отвечает сервер старее фронта. Карточка
// обязана промолчать, а не рухнуть, утащив за собой весь раздел: обе строки выше
// («карточка контура на экране») об этом же, но здесь это сказано вслух.
check(!card.includes('Проверки контента контура'), 'без сводки карточка проверок не рисуется');

gatewayViolations = VIOLATIONS;
await open();
const checks = await page.locator('body').innerText();
check(
  checks.includes('Проверки контента контура'),
  'карточка проверок появилась вместе со сводкой',
);
check(
  checks.includes('панель их не зовёт'),
  'сказано, что проверки принадлежат компании и панель ими не управляет',
);
check(checks.includes('pii-detector'), 'название проверки показано так, как назвал его контур');
check(
  checks.includes('данные замаскировали') &&
    checks.includes('запрос не приняли') &&
    checks.includes('ответ оборвали'),
  'три исхода различены, а не слиты в «сработала проверка»',
);
check(
  checks.includes('что случилось — контур не сказал'),
  'проверка без исхода подписана словами, а не пустым местом',
);
check(
  checks.includes('не назвав ни одной проверки'),
  'безымянное срабатывание показано, а не потеряно',
);
// Текст лежит в следе запроса, который панель получила вместе со сводкой:
// проверка красная, если карточка когда-нибудь начнёт печатать сырые поля.
check(!checks.includes(CHECKED_TEXT), 'проверявшегося текста на экране нет');
check(!checks.includes('4017'), 'ни куска проверявшегося текста');
check(checks.includes('Считаем по последним запросам'), 'сказано, с какого момента идёт счёт');

// --- Агенты контура -------------------------------------------------------

check(checks.includes('Агенты контура'), 'карточка агентов на экране включённого контура');
check(
  checks.includes('Список ведёте вы') || checks.includes('маршрута «покажи агентов» у ключа нет'),
  'сказано, почему список агентов человек ведёт сам',
);
check(checks.includes('Юрист компании'), 'добавленный агент показан своим именем');
check(
  checks.includes('0f4b2a10-77c3-4d1e-9f0a-2b6c8d5e1a33'),
  'идентификатор агента виден — его человек сверяет с админкой',
);

await page.getByLabel('Вопрос').fill('Как оформить договор подряда?');
await page.getByRole('button', { name: 'Спросить' }).click();
await page.waitForTimeout(800);

const asked = posted.find((item) => item.kind === 'ask');
check(
  asked?.body?.agent === '0f4b2a10-77c3-4d1e-9f0a-2b6c8d5e1a33',
  'вопрос ушёл выбранному агенту',
);
check(
  typeof asked?.body?.session === 'string' && asked.body.session.length > 0,
  `сессия заведена панелью — у контура такой ручки нет: ${asked?.body?.session ?? 'нет'}`,
);

const answered = await page.locator('body').innerText();
check(answered.includes('Договор подряда с физлицом'), 'ответ агента показан');
check(answered.includes('Ответил'), 'исход вызова назван словом');
check(
  answered.includes('в сессию этот ход не попал'),
  'пропущенный сессией ход назван вслух, а не оставлен человеку в догадки',
);
check(answered.includes('Контур помнит'), 'переписку показывает контур, а не копия панели');
// Ключа в вопросе агенту быть не может: в контур ходит сервер, взяв ключ из
// шифрованного хранилища. Сторожит это общая проверка исходящих в конце прогона
// — здесь она была бы зелена всегда, страницу между вводом ключа и вопросом
// перезагружали.

await page.getByRole('button', { name: 'Сбросить сессию' }).click();
await page.waitForTimeout(500);
check(
  posted.some((item) => item.kind === 'session-reset'),
  'сброс сессии ушёл в контур, а не только погасил экран',
);

await page.getByRole('button', { name: 'Включить переходник' }).click();
await page.waitForTimeout(600);
check(
  (await page.getByRole('button', { name: 'Выключить переходник' }).count()) > 0,
  'переходник MCP включается и называет своё состояние',
);

// Запись переходника ОДНА на все контуры (её инструменты принимают контур
// параметром). Кнопка в каждой карточке означала бы, что переходников столько
// же, сколько контуров, — и вторая молча переключала бы первый.
platforms = [
  cardOf(),
  cardOf({
    platform: { ...PLATFORM, id: 'enterprise-platform-prod', title: 'EnterprisePlatform · prod' },
    maskedToken: 'sk-…9c07',
  }),
];
await open();
const two = await page.locator('body').innerText();
check(
  (two.match(/Агенты контура/g) ?? []).length === 2,
  'у каждого включённого контура своя карточка агентов',
);
check(
  (await page.getByRole('button', { name: /переходник/ }).count()) === 1,
  'переходник один на все контуры, а не по кнопке на карточку',
);

// Выключенный контур обязан вернуть раздел к прежнему виду побайтно.
platforms = [cardOf({ platform: { ...PLATFORM, enabled: false } })];
await open();
const offText = await page.locator('body').innerText();
check(
  !offText.includes('Проверки контента контура'),
  'контур выключен — карточки проверок нет вовсе',
);
check(!offText.includes('Агенты контура'), 'контур выключен — карточки агентов нет вовсе');

platforms = [cardOf()];
await open();

const rollback = page.getByRole('button', { name: 'Откатить' }).first();
check((await rollback.count()) > 0, 'у строки журнала есть точечный откат');
await rollback.click();
await page.waitForTimeout(600);
const disableCall = posted.find((item) => item.kind === 'disable');
check(
  Array.isArray(disableCall?.body?.targets) && disableCall.body.targets.length === 1,
  `откат снял одну цель, а не всё разом: ${JSON.stringify(disableCall?.body?.targets ?? null)}`,
);

// --- Расход контура на странице разбора (Т8) ------------------------------

// Цифры контура стоят там ОТДЕЛЬНО и в общий расход не входят: выше собраны
// транскрипты этой машины, здесь — кадры через наш шлюз, и у работы через контур
// есть и то и другое. Сложенные, они посчитали бы одни токены дважды.
await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
const analytics = await page.locator('body').innerText();
check(analytics.includes('Расход через контур'), 'расход контура показан своей карточкой');
check(
  analytics.includes('в цифры выше это не входит'),
  'сказано, что складывать эти цифры с общими нельзя',
);
check(
  analytics.includes('По нашему прайсу — оценка') && !analytics.includes('единица контура'),
  'величина названа своим именем и объявлена оценкой, а не выдана за цифру контура',
);
check(
  analytics.includes('2026-09-10') && analytics.includes('2026-09-09'),
  'разбивка по дням на месте — по ней видно, когда именно тратили',
);

// Найдено враждебным ревью Т8: карточка пряталась по ПЕРИОДУ бюджета, а не по
// «хоть что-то прошло». Сдвинув «считать с» на сегодня, человек уносил с экрана
// историю, которая есть, — и без единого слова о том, куда она делась.
platforms = [cardOf({ periodSpend: { ...PERIOD_SPEND, requests: 0 } })];
await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
const shifted = await page.locator('body').innerText();
check(
  shifted.includes('Расход через контур') && shifted.includes('2026-09-10'),
  'пустой период не уносит с экрана историю, которая есть',
);

// Итог по ключу — за весь прогон, а не за один экран: мастер, проверка, вопрос
// агенту, сброс сессии, переходник, применение и откат. Единственное законное
// место — поле `token` сохранения.
check(
  secretSightings.every((place) => place.endsWith('.token')),
  `за весь прогон ключ ехал только своим полем: ${secretSightings.join(', ')}`,
);

await finish(
  bad === 0 ? 0 : 1,
  bad === 0 ? 'Раздел «Контур» ведёт себя как обещано' : `Проблем: ${bad}`,
);
