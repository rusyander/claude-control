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
  // Потребители приезжают с сервера ВСЕГДА: контуру, заведённому до Т3, их
  // подставляет `readPlatforms` из его же целей (ассистент + файлы CLI). Здесь
  // записан именно тот результат — заглушка без этого поля обещала бы форму
  // ответа, которой панель не отдаёт.
  consumers: ['assistant', 'terminal'],
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

/**
 * Итог пробного запроса — того, что идёт через СВОЙ ЖЕ шлюз. Он приезжает в
 * карточке и переживает перезагрузку: «модель ответила» — свойство связки, а не
 * события нажатия.
 */
const SMOKE_OK = {
  ok: true,
  model: 'gpt-4o',
  answer: 'готов',
  latencyMs: 1_240,
  at: new Date().toISOString(),
};

/** Тот же путь, но шлюз погашен: активация состоялась, запрос — нет. */
const SMOKE_FAILED = {
  ok: false,
  model: 'gpt-4o',
  answer: '',
  latencyMs: 12,
  at: new Date().toISOString(),
  detail: 'Шлюз не поднят: пробный запрос идёт через него, как и работа CLI.',
};

/**
 * Карточка контура так, как её отдаёт сервер: настройка, ключ маской, расход.
 *
 * По умолчанию контур АКТИВЕН — так его и видит человек сразу после мастера.
 * Тумблер идёт за активностью и отдельно не задаётся: «включён, но не активен»
 * на сервере невозможно (инвариант 1), и рисовать экран по такой паре значило
 * бы проверять состояние, которого не бывает.
 */
const cardOf = ({ active = true, platform = PLATFORM, ...patch } = {}) => ({
  platform: { ...platform, enabled: active },
  hasToken: true,
  maskedToken: 'sk-…4f21',
  health: PROBE,
  active,
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
  // «Где работает контур» (Т3): прогоны, ассистент, чужой CLI «только
  // глобально» и терминал — тот же состав, что собирает сервер.
  consumers: [
    { id: 'chat', title: '', selected: false, scope: 'run' },
    { id: 'groups', title: '', selected: false, scope: 'run' },
    { id: 'tests', title: '', selected: false, scope: 'run' },
    { id: 'assistant', title: '', selected: true, scope: 'profile' },
    { id: 'foreign:qwen', title: 'Qwen Code', selected: false, scope: 'run' },
    { id: 'foreign:codex', title: 'Codex', selected: false, scope: 'run', reason: 'file_only' },
    { id: 'terminal', title: '', selected: applied, scope: 'files' },
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

/**
 * Сводка прослойки инструментов (Т5.5). Числа подобраны так, чтобы карточка
 * говорила обо всех трёх своих состояниях сразу: ход с вызовом был, ход с
 * заявкой без вызова тоже, и один блок вызовом не стал.
 */
const TOOL_SHIM = {
  requests: 5,
  turns: 3,
  calls: 4,
  claimed: 2,
  flaws: [{ reason: 'нет закрывающего тега', count: 1 }],
  since: new Date(Date.now() - 1_800_000).toISOString(),
};

/** Сводка прослойки в ответе шлюза. Меняется по ходу прогона. */
let gatewayToolShim;

const gatewayInfo = () => ({
  ...GATEWAY,
  status: {
    ...GATEWAY.status,
    ...(gatewayViolations
      ? { violations: gatewayViolations, events: [POISONED_EVENT] }
      : { events: [] }),
    ...(gatewayToolShim ? { toolShim: gatewayToolShim } : {}),
  },
});

/** Что заглушка отдаёт списком. Меняется по ходу прогона. */
let platforms = [];
/** Активный контур и разовый рассказ о переносе — оба едут в ответе списка. */
let activePlatformId = '';
let activationNotice;
/** Чем ответит активация: зелёным пробным запросом или красным. */
let activationSmoke = SMOKE_OK;
/**
 * Сколько активация «думает». Настоящая идёт до 45 с (проба плюс пробный
 * запрос), и повторное нажатие за это время отправило бы второй такой же
 * запрос — проверить это можно только на медленном ответе.
 */
let activateDelayMs = 0;
/** Список контуров ОТКАЗАЛ. Так выглядит полупогасшая панель и закрытый доступ. */
let platformsFail = false;
const platformsInfo = () => ({
  platforms,
  activePlatformId,
  ...(activationNotice ? { activationNotice } : {}),
});
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
  if (path === '') {
    // Отказ списка — не редкость: панель поднята наполовину, удалённый доступ
    // закрыт токеном, сеть моргнула. Экран обязан пережить это, не выдумывая
    // за сервер, чего он не говорил.
    if (platformsFail) return route.fulfill({ status: 500, json: { message: 'стенд' } });
    return json(platformsInfo());
  }

  // Рассказ о переносе разовый: закрыли — сервер его стирает, и второй раз он
  // не приезжает. Проверка ниже смотрит именно на это, а не на то, что он
  // пропал с экрана до перезагрузки.
  if (path === 'activation-notice' && method === 'DELETE') {
    posted.push({ kind: 'notice-dismiss', body: path });
    activationNotice = undefined;
    return route.fulfill({ status: 204, body: '' });
  }

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
  if (method === 'POST' && tail === 'activate') {
    posted.push({ kind: 'activate', body: path });
    if (activateDelayMs > 0) await new Promise((done) => setTimeout(done, activateDelayMs));
    const previous = activePlatformId;
    activePlatformId = path.split('/')[0] ?? '';
    // Сервер отвечает СОСТОЯНИЕМ, и список после него отдаёт то же самое:
    // активность — свойство карточки, а не выделение на экране.
    platforms = platforms.map((item) => ({
      ...item,
      active: item.platform.id === activePlatformId,
      platform: { ...item.platform, enabled: item.platform.id === activePlatformId },
      ...(item.platform.id === activePlatformId ? { smoke: activationSmoke } : {}),
    }));
    return json({
      activePlatformId,
      previousPlatformId: previous === activePlatformId ? '' : previous,
      probe: PROBE,
      smoke: activationSmoke,
    });
  }
  if (method === 'POST' && tail === 'deactivate') {
    posted.push({ kind: 'deactivate', body: path });
    activePlatformId = '';
    platforms = platforms.map((item) => ({
      ...item,
      active: false,
      platform: { ...item.platform, enabled: false },
    }));
    return json({ entries: [{ targetId: 'claude', filePath: '', outcome: 'restored' }] });
  }
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
  return json(platformsInfo());
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

/**
 * Переход с одной повторной попыткой: стенд — общий и живой, и правка любого
 * файла фронта роняет в него перезагрузку Vite. Она обрывает переход, начатый
 * в ту же секунду (`ERR_ABORTED`), и прогон падает не на том, что проверяет.
 * Повторяется РОВНО переход: любой другой отказ летит дальше как есть.
 */
const goto = async (url) => {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!String(error?.message ?? '').includes('ERR_ABORTED')) throw error;
    await page.waitForTimeout(1500);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('nav');
};

const open = async () => {
  await goto(`${BASE}/platform`);
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

// --- Мастер: где работает контур (Т3) -------------------------------------

await page.getByRole('button', { name: 'Далее' }).click();
await page.waitForTimeout(700);
const stepFour = await page.locator('[role="dialog"]').innerText();
check(stepFour.includes('Где работает контур'), 'список потребителей на шаге');
check(
  stepFour.includes('Чат') && stepFour.includes('Агент тестов'),
  'прогоны названы по отдельности, а не одним «включено»',
);
check(
  stepFour.includes('на один прогон') && stepFour.includes('профилем панели'),
  'человеку видно, чем маршрут прогона отличается от профиля панели',
);

/** Строка потребителя с галочкой — по видимому имени. */
const consumerBox = (title) =>
  page.locator('[role="dialog"] label', { hasText: title }).locator('input[type="checkbox"]');

check(await consumerBox('Ассистент панели').isChecked(), 'ассистент предвыбран');
// Ровно он один: «предвыбран» без этой строки истинно и тогда, когда отмечено
// всё подряд, а молча увести рабочий чат в контур — это и есть то, чего
// умолчание делать не должно.
check(!(await consumerBox('Чат').isChecked()), 'чат сам собой в контур не уехал');
check(!(await consumerBox('Агент тестов').isChecked()), 'агент тестов — тоже нет');

check(
  stepFour.includes('только глобально: адрес этого CLI живёт в его файле'),
  'чужой CLI с адресом в файле помечен «только глобально» с причиной',
);
check(
  (await page.locator('[role="dialog"] label', { hasText: 'Codex' }).count()) === 0,
  'и галочки у него нет вовсе — обещания, которого панель не держит, на экране нет',
);
check(
  stepFour.includes('останется без модели'),
  'режим «обязательно» показывает, что будет при выключенной панели',
);

// Файловые цели — только под снятым замком «Терминала»: до Т3 этот список был
// единственным смыслом шага, теперь он принадлежит одному потребителю. Ищется
// ПУТЬ ФАЙЛА, а не заголовок «Где применять»: так называется и сам шаг мастера,
// и проверка по нему была бы истинной всегда.
check(
  !stepFour.includes('/home/u/.claude/settings.json'),
  'список файлов CLI скрыт, пока терминал не отмечен',
);
// У НОВОГО контура оговорки про оставшиеся файлы быть не может: применять ещё
// нечего, и предупреждение о том, чего не происходило, пугало бы на ровном
// месте. Настоящий случай — ниже, в правке уже применённого контура.
check(
  !stepFour.includes('Файлы CLI остаются применёнными'),
  'у нового контура оговорки про оставшиеся файлы нет — применять нечего',
);
await consumerBox('Терминал').click();
await page.waitForTimeout(400);
const withTerminal = await page.locator('[role="dialog"]').innerText();
check(
  withTerminal.includes('/home/u/.claude/settings.json'),
  'отмеченный терминал открывает список файлов CLI — с путём, который будет переписан',
);
check(withTerminal.includes('Claude Code'), 'в нём настоящая цель из плана');
// Причины прочерков у файловых целей — свои, и их две разных: у одного CLI нет
// файла переменных вовсе, другой говорит на чужом диалекте.
check(
  withTerminal.includes('говорит на диалекте, которого шлюз не понимает'),
  'вторая причина прочерка отличается от первой',
);
check(
  (await page.locator('[data-compromise-mark="cli-no-endpoint"]').count()) > 0,
  'прочерк файловой цели подписан',
);
// Ассистент остался ВЫШЕ, среди потребителей: спрашивать о нём дважды значило
// бы получить два разных ответа на один вопрос.
check(
  (await page
    .locator('[role="dialog"] label', { hasText: 'Ассистент панели' })
    .locator('input[type="checkbox"]')
    .count()) === 1,
  'ассистент спрашивается один раз, а не и целью, и потребителем',
);
await consumerBox('Терминал').click();
// А чат — наоборот, руками: ровно тот выбор, ради которого Т3 и делалась.
await consumerBox('Чат').click();
await page.waitForTimeout(300);

await page.getByRole('button', { name: 'Готово' }).click();
await page.waitForTimeout(800);
const applyCall = posted.find((item) => item.kind === 'apply');
check(Boolean(applyCall), 'применение отправлено');

// Выбор уезжает на сервер полем контура, а не догадкой по целям: без этого он
// не пережил бы ни перезапуск панели, ни перенос окружения.
// ПОСЛЕДНЕЕ сохранение, а не первое: мастер сохраняет контур ещё на шаге пробы,
// до того как человек дошёл до потребителей, и первая запись честно приезжает с
// умолчаниями.
const saveCall = posted.filter((item) => item.kind === 'save').at(-1);
const savedConsumers = saveCall?.body?.platform?.consumers ?? saveCall?.body?.settings?.consumers;
check(
  Array.isArray(savedConsumers) && savedConsumers.includes('chat'),
  `отмеченный чат сохранён потребителем: ${JSON.stringify(savedConsumers ?? null)}`,
);
check(
  Array.isArray(savedConsumers) && !savedConsumers.includes('terminal'),
  'снятый терминал в сохранённых не остался',
);
check(
  applyCall?.body?.targets?.includes('claude') !== true,
  `со снятым терминалом файлы CLI в применение не уехали: ${JSON.stringify(applyCall?.body?.targets ?? [])}`,
);
// Включённый контур — это активный контур и никакой другой: мастер обязан
// пройти через активацию, а не проставить тумблер сохранением.
check(
  posted.some((item) => item.kind === 'activate'),
  'мастер сделал контур активным, а не включил его сохранением',
);
// Оба места обязаны НАЙТИСЬ: «-1 < n» истинно и тогда, когда активации не было
// вовсе, и такая проверка порядка не доказывает ничего.
const activateAt = posted.findIndex((item) => item.kind === 'activate');
const applyAt = posted.findIndex((item) => item.kind === 'apply');
check(
  activateAt >= 0 && applyAt >= 0 && activateAt < applyAt,
  `активация легла до применения — иначе цели вернулись бы негодными (${activateAt} → ${applyAt})`,
);
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

// --- Активный контур: ровно один (Т2) --------------------------------------

// Настроенный, но не активный контур: работа идёт не через него, и карточка
// обязана сказать это словом, а не отсутствием отметки.
activePlatformId = '';
platforms = [cardOf({ active: false })];
await open();
const idle = await page.locator('body').innerText();
check(idle.includes('не активен'), 'неактивный контур назван словом');
check(
  (await page.getByRole('button', { name: 'Сделать активным' }).count()) > 0,
  'у неактивного контура есть кнопка активации',
);
check(
  (await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) === 0,
  'возвращать нечего, пока контур не активен',
);

// Ключа нет — спрашивать контур нечем: кнопка гаснет и называет причину, а не
// отвечает отказом после нажатия.
platforms = [cardOf({ active: false, hasToken: false, maskedToken: '' })];
await open();
const noKeyButton = page.getByRole('button', { name: 'Сделать активным' });
check(await noKeyButton.isDisabled(), 'без ключа активировать нельзя');
check(
  ((await noKeyButton.getAttribute('title')) ?? '').includes('ключ'),
  'у погашенной кнопки написана причина',
);

// Активация: отметка, кнопка возврата и итог пробного запроса — всё из ответа
// сервера, и всё переживает перезагрузку страницы.
platforms = [cardOf({ active: false })];
activationSmoke = SMOKE_OK;
await open();
await page.getByRole('button', { name: 'Сделать активным' }).click();
await page.waitForTimeout(700);
check(
  posted.filter((item) => item.kind === 'activate').length > 1,
  'нажатие ушло своим маршрутом активации',
);
const activeText = await page.locator('body').innerText();
check(!activeText.includes('не активен'), 'контур помечен активным, а не наоборот');
check(
  activeText.includes('«готов»') && activeText.includes('gpt-4o'),
  'ответ модели и её имя показаны на карточке',
);
check(activeText.includes('1.2 с'), 'задержка пробного запроса названа');
check(
  (await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) > 0,
  'у активного контура есть возврат к провайдеру по умолчанию',
);

// Красный пробный запрос активацию НЕ отменяет: причина написана словами, а
// контур остаётся активным — решает человек.
activePlatformId = '';
platforms = [cardOf({ active: false })];
activationSmoke = SMOKE_FAILED;
await open();
await page.getByRole('button', { name: 'Сделать активным' }).click();
await page.waitForTimeout(700);
const smokeBad = await page.locator('body').innerText();
check(smokeBad.includes('Шлюз не поднят'), 'причина отказа пробного запроса написана словами');
// Доказательство «контур остался активным» — кнопка возврата: слово «активен»
// здесь не годится, оно же стоит внутри «не активен».
check(
  (await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) > 0,
  'красный пробный запрос активацию не отменил',
);

// Возврат к провайдеру по умолчанию — из карточки.
await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).click();
await page.waitForTimeout(700);
check(
  posted.some((item) => item.kind === 'deactivate'),
  'возврат ушёл своим маршрутом',
);
check(
  (await page.getByRole('button', { name: 'Сделать активным' }).count()) > 0,
  'после возврата контур снова можно сделать активным',
);

// Два контура на экране разом — то самое, ради чего инвариант 1 и заведён.
// Каждая проверка выше держала на экране ОДНУ карточку, а «активировали второй
// — первый погас» на одной карточке не видно вовсе.
activePlatformId = PLATFORM.id;
activationSmoke = SMOKE_OK;
const SECOND = { ...PLATFORM, id: 'enterprise-platform-prod', title: 'EnterprisePlatform · prod' };
platforms = [cardOf({ smoke: SMOKE_OK }), cardOf({ active: false, platform: SECOND })];
await open();

const firstCard = page.locator(`[data-platform-card="${PLATFORM.id}"]`);
const secondCard = page.locator(`[data-platform-card="${SECOND.id}"]`);
check((await secondCard.count()) === 1, 'обе карточки на экране');
check(
  (await firstCard.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) === 1,
  'возврат стоит у активного контура',
);
check(
  (await secondCard.getByRole('button', { name: 'Сделать активным' }).count()) === 1,
  'у второго контура — кнопка активации',
);

await secondCard.getByRole('button', { name: 'Сделать активным' }).click();
await page.waitForTimeout(900);
check(
  (await firstCard.innerText()).includes('не активен'),
  'первый контур погас, когда активным стал второй',
);
check(
  (await firstCard.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) === 0,
  'у погасшего контура возврата больше нет',
);
check(
  (await secondCard.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) === 1,
  'возврат переехал на второй контур',
);
check(
  (await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) === 1,
  'возврат на странице ровно один: активных контуров не бывает двое',
);

// Итог пробного запроса — у АКТИВНОГО контура и только у него. У погасшего это
// итог прошлой активации, а шлюз сегодня отвечает на его адрес отказом: зелёная
// строка «модель ответила» под словом «не активен» — прямая ложь.
check(
  !(await firstCard.innerText()).includes('Пробный запрос прошёл'),
  'у неактивного контура зелёного пробного запроса нет',
);
check(
  (await secondCard.innerText()).includes('Пробный запрос прошёл'),
  'у активного контура итог пробного запроса на месте',
);
check(
  (await secondCard.innerText()).includes('спрошено'),
  'у пробного запроса названо время: запись переживает перезагрузку панели',
);

// Пока активация идёт (настоящая — до 45 с), кнопка обязана быть недоступна:
// второе нажатие отправило бы вторую такую же транзакцию.
activePlatformId = '';
platforms = [cardOf({ active: false })];
activateDelayMs = 1_500;
await open();
posted.length = 0;
const slowButton = page.getByRole('button', { name: 'Сделать активным' });
await slowButton.click();
await page.waitForTimeout(200);
check(await slowButton.isDisabled(), 'на время запроса кнопка активации недоступна');
await page.waitForTimeout(2_000);
check(posted.filter((item) => item.kind === 'activate').length === 1, 'активация ушла ровно одна');
activateDelayMs = 0;

// Правка контура активность НЕ переносит. Та же форма открывается кнопкой
// «Настройка контура» на любой карточке, и «Готово» в ней означает «сохранить
// поправленное»; о переводе всей машины на этот контур не говорит ни подпись
// кнопки, ни заголовок.
activePlatformId = PLATFORM.id;
platforms = [cardOf({ smoke: SMOKE_OK }), cardOf({ active: false, platform: SECOND })];
await open();
posted.length = 0;
await secondCard.getByRole('button', { name: 'Настроить' }).click();
await page.waitForTimeout(500);
for (const step of [1, 2, 3]) {
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.waitForTimeout(step === 2 ? 900 : 400);
}

// Контур УЖЕ применён к файлам, и «Терминал» у него отмечен. Снятая галочка
// прячет список файловых целей — и на этом человек мог бы решить, что файлы
// вернулись сами. Они не вернулись: потребитель решает, кому писать ВПРЕДЬ, а
// возвращает файлы отдельная кнопка на карточке. Панель обязана сказать это на
// том же экране, где галочка снимается.
const terminalRow = page
  .locator('[role="dialog"] label', { hasText: 'Терминал' })
  .locator('input[type="checkbox"]');
check(await terminalRow.isChecked(), 'у применённого контура терминал отмечен');
await terminalRow.click();
await page.waitForTimeout(400);
const terminalOff = await page.locator('[role="dialog"]').innerText();
check(
  terminalOff.includes('Файлы CLI остаются применёнными'),
  'снятый терминал не выдаёт скрытый список за снятое применение',
);
check(
  terminalOff.includes('Снять применение'),
  'и названа кнопка, которой файлы возвращаются на самом деле',
);
await terminalRow.click();
await page.waitForTimeout(400);
check(
  !(await page.locator('[role="dialog"]').innerText()).includes('Файлы CLI остаются применёнными'),
  'оговорка уходит вместе с возвращённой галочкой — она про снятую',
);

await page.getByRole('button', { name: 'Готово' }).click();
await page.waitForTimeout(900);
check(
  posted.some((item) => item.kind === 'save'),
  'правка сохранилась',
);
check(
  !posted.some((item) => item.kind === 'activate'),
  'правка не сделала контур активным: об этом «Готово» не предупреждало',
);
check(activePlatformId === PLATFORM.id, 'активным остался тот контур, что и был');

// Перенос старых настроек: включённых контуров было несколько. Рассказ разовый
// — закрытие обязано дойти до сервера, а не спрятать его до перезагрузки.
activePlatformId = PLATFORM.id;
activationNotice = {
  activatedId: PLATFORM.id,
  activatedTitle: PLATFORM.title,
  others: ['EnterprisePlatform · prod'],
};
platforms = [cardOf()];
await open();
const migrated = await page.locator('body').innerText();
check(migrated.includes('Активным стал контур'), 'о переносе сказано на экране');
check(migrated.includes('EnterprisePlatform · prod'), 'оставшиеся контуры названы поимённо');
check(
  migrated.includes('остались настроенными') || migrated.includes('ключами и бюджетами'),
  'сказано, что остальные контуры не потеряны',
);
await page.getByRole('button', { name: 'Понятно' }).click();
await page.waitForTimeout(500);
check(
  posted.some((item) => item.kind === 'notice-dismiss'),
  'закрытие рассказа дошло до сервера — иначе он вернулся бы после перезагрузки',
);
await open();
check(
  !(await page.locator('body').innerText()).includes('Активным стал контур'),
  'закрытый рассказ не приезжает второй раз',
);

activePlatformId = '';
activationNotice = undefined;

// --- Возврат из второго места: настройки → «Свой эндпоинт» (Т2) -------------

// Первое место возврата — карточка контура выше. Второе — настройки, и оно
// важнее: человек приходит туда «поправить адрес модели», находит профиль,
// которого не заводил, и правит адрес, ведущий в локальный шлюз. Проверка
// водит именно ТОТ экран, а не повторяет карточку: до 11.09.2026 второе место
// не трогал ни один живой прогон.
//
// Настройки стенда берутся НАСТОЯЩИЕ и правится в них одно поле: подменять
// объект целиком значило бы проверять свою выдумку о его форме, а не страницу.
let managedOwnerId = PLATFORM.id;
await page.route('**/api/settings', async (route) => {
  if (route.request().method() !== 'GET') return route.fallback();
  const response = await route.fetch();
  const settings = await response.json();
  return route.fulfill({
    response,
    json: {
      ...settings,
      endpointProfiles: [
        {
          // Имя профиля нарочно НЕ содержит названия контура: иначе проверка
          // «владелец назван» была бы зелена от самой заглушки.
          id: 'ep-managed',
          name: 'Профиль из панели',
          baseUrl: 'http://127.0.0.1:5177/enterprise-platform-dev',
          apiKind: 'openai-compat',
          model: 'enterprise-platform-corp-m',
          writeToken: true,
          ownerPlatformId: managedOwnerId,
        },
      ],
    },
  });
});

const openSettings = async () => {
  await goto(`${BASE}/settings?tab=models`);
  await page.waitForTimeout(1500);
};

activePlatformId = PLATFORM.id;
platforms = [cardOf()];
await openSettings();
const managed = await page.locator('body').innerText();
check(
  managed.includes('Профиль ведёт контур «EnterprisePlatform · dev»'),
  'в настройках назван контур — владелец профиля',
);
check(
  managed.includes('уведёт CLI мимо контура'),
  'сказано, чем обернётся правка полей такого профиля руками',
);
check(
  (await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) > 0,
  'возврат есть и во втором месте — в настройках',
);
check(
  (await page.getByRole('button', { name: 'Удалить профиль' }).count()) === 0,
  'профиль контура нельзя убрать руками: применение осталось бы в файлах CLI',
);

posted.length = 0;
await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).click();
await page.waitForTimeout(900);
check(
  posted.some((item) => item.kind === 'deactivate'),
  'возврат из настроек ушёл тем же маршрутом, что и с карточки',
);

// Контур удалили, а профиль остался: возвращать нечего, и обычная кнопка
// удаления обязана вернуться — иначе профиль-сирота не убрать вовсе.
managedOwnerId = 'enterprise-platform-которого-нет';
activePlatformId = '';
platforms = [cardOf({ active: false })];
await openSettings();
const orphan = await page.locator('body').innerText();
check(
  orphan.includes('больше нет — профиль можно удалить'),
  'профиль-сирота назван сиротой, а не чужим именем',
);
check(
  (await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) === 0,
  'у сироты возврата нет: возвращать нечего',
);
check(
  (await page.getByRole('button', { name: 'Удалить профиль' }).count()) > 0,
  'профиль-сироту можно убрать обычной кнопкой',
);

// Список контуров ОТКАЗАЛ — и это не то же самое, что «контура нет». Владелец
// профиля неизвестен ровно так же (ответа нет), но сказать «контура больше нет»
// и подставить кнопку удаления значит предложить убрать профиль контура,
// который всё ещё применён к файлам CLI. Найдено враждебным ревью Т2.
managedOwnerId = PLATFORM.id;
platformsFail = true;
await openSettings();
const failed = await page.locator('body').innerText();
check(
  !failed.includes('больше нет — профиль можно удалить'),
  'при отказе списка панель не выдумывает, что контур удалён',
);
check(
  (await page.getByRole('button', { name: 'Удалить профиль' }).count()) === 0,
  'профиль контура нельзя удалить руками, пока о контуре ничего не известно',
);
check(
  (await page.getByRole('button', { name: 'Вернуть провайдер по умолчанию' }).count()) > 0,
  'возврат остаётся: он идёт по идентификатору и списка не ждёт',
);
platformsFail = false;

await page.unroute('**/api/settings');
managedOwnerId = PLATFORM.id;
activePlatformId = PLATFORM.id;
// Возврат на карточку: проверки ниже смотрят на живой экран раздела, а не на
// снятый раньше текст, и настройки под ними — чужая страница.
platforms = [cardOf()];
await open();

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

// --- Инструменты через контур (Т5.5) --------------------------------------

// Сводки прослойки в ответе шлюза нет — так отвечает сервер старее фронта, и
// карточка обязана промолчать, а не нарисовать «вызовов 0» о том, чего не знает.
check(!checks.includes('Инструменты через контур'), 'без сводки прослойки карточка не рисуется');

gatewayToolShim = { requests: 0, turns: 0, calls: 0, claimed: 0, flaws: [] };
await open();
const shimIdle = await page.locator('body').innerText();
check(
  shimIdle.includes('Инструменты через контур') &&
    shimIdle.includes('ещё не проходило ни одного запроса с инструментами'),
  'пустая сводка объяснена словами, а не нулями',
);
check(!shimIdle.includes('ходов с инструментами'), 'счёт ходов без запросов не показывается вовсе');

gatewayToolShim = TOOL_SHIM;
await open();
const shim = await page.locator('body').innerText();
check(shim.includes('ходов с инструментами: 3'), 'ходы с настоящими вызовами посчитаны');
check(
  shim.includes('вызовов 4 в 5 запросах с инструментами'),
  'рядом с ходами видно, сколько вызовов и из скольких запросов',
);
// Самое тихое место раздела: ответ удачный, а руками не сделано ничего. Без
// этой строки человек ищет поломку в панели, которой нет.
check(
  shim.includes('описала действие и не вызвала ничего'),
  'ход с заявкой без вызова назван человеку',
);
check(
  shim.includes('нет закрывающего тега') && shim.includes('1 раз'),
  'блок, не ставший вызовом, показан своей причиной',
);
check(
  shim.includes('перезапуск панели обнуляет его целиком'),
  'сказано, что след ограничен и обнуляется перезапуском',
);
// Подпись компромисса: вызов текстом — решение, а не поломка, и снимается она
// сервером, а не разметкой.
check(
  (await page.locator('[data-compromise-mark="tool-shim"]').count()) > 0,
  'карточка подписана компромиссом прослойки',
);

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

// Неактивный контур обязан вернуть раздел к прежнему виду побайтно.
platforms = [cardOf({ active: false })];
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
await goto(`${BASE}/analytics`);
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
await goto(`${BASE}/analytics`);
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
