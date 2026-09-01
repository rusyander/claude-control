/**
 * Прогон продолжения работы в чистой сессии («автоклир»).
 *
 * Проверяется то, из-за чего эта штука способна навредить: что вместо блока с
 * JSON человек видит карточку с составом, что «остаться здесь» — такой же
 * законный ход, как согласие, что без согласия НИЧЕГО не заводится, и что
 * тумблеры («только завести чат», «дальше продолжай сам») действительно
 * доезжают до сервера — иначе панель молча стирала бы контекст разговора.
 *
 * Данные подменяются целиком: ни настоящих разговоров, ни запущенных агентов
 * прогон не создаёт — на диске после него не остаётся ничего.
 *
 * Запуск: `node tools/qa/check-handoff.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const CHAT_ID = 'qa-handoff-chat';
/** Каталога на диске нет: прогон ничего в файловой системе не трогает. */
const PROJECT = { name: 'QA продолжение', path: 'C:/qa-handoff-project' };

const PROPOSAL = {
  done: 'Закрыт экспорт отчётов: маршрут, тесты и справка.',
  next: 'Взяться за импорт: разобрать формат CSV и написать разбор.',
  checkpoint: '.agent/PROGRESS.md',
  pruned: 'Из TASKS.md убраны три сделанных пункта, уехали в .agent/ARCHIVE.md.',
};

const block = (json) => ['```claude-control:handoff', JSON.stringify(json), '```'].join('\n');

const CHAT = {
  id: CHAT_ID,
  title: 'Продолжение этапа',
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 2,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:05:00.000Z',
  preview: 'Этап закрыт',
};

const MESSAGES = {
  messages: [
    {
      id: 'm-old',
      role: 'assistant',
      blocks: [{ type: 'text', text: `Старое предложение.\n\n${block(PROPOSAL)}` }],
      timestamp: '2026-09-01T10:01:00.000Z',
    },
    {
      id: 'm-last',
      role: 'assistant',
      blocks: [{ type: 'text', text: `Этап закрыт.\n\n${block(PROPOSAL)}\n\nЖду решения.` }],
      timestamp: '2026-09-01T10:05:00.000Z',
    },
  ],
  total: 2,
  hasMore: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

/** Что ушло на сервер: по этому и судим, а не по виду кнопок. */
let sent;
let handoffBody;
let autoBody;

// Каталога проекта на диске нет — настоящий git-пульт ответил бы отказом и
// засорил консоль. Проверяем не его, поэтому отвечаем «не репозиторий».
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
        lastActivity: '2026-09-01T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/chats', (route) => route.fulfill({ json: [CHAT] }));
await page.route(`**/api/chats/${CHAT_ID}/messages*`, (route) => route.fulfill({ json: MESSAGES }));
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
await page.route(`**/api/chat/${CHAT_ID}/progress*`, (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route(`**/api/chat/${CHAT_ID}/artifacts*`, (route) => route.fulfill({ json: [] }));

await page.route('**/api/chat/send', (route) => {
  sent = route.request().postDataJSON();
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"type":"done","seq":1}\n\n',
  });
});

// Состояние цепочки живёт на сервере: тумблер переживает перезагрузку вкладки,
// а номер шага показывает, что автомат не бесконечен.
await page.route('**/api/chat/handoff/state*', (route) =>
  route.fulfill({ json: { auto: false, depth: 1, maxChain: 5 } }),
);

await page.route('**/api/chat/handoff/auto', (route) => {
  autoBody = route.request().postDataJSON();
  return route.fulfill({ json: { auto: autoBody.enabled === true, depth: 1 } });
});

// Текст просьбы отдаёт сервер — второй копии инструкции в клиенте быть не должно.
await page.route('**/api/chat/handoff/request', (route) =>
  route.fulfill({ json: { prompt: 'Закрой этап и выведи блок claude-control:handoff.' } }),
);

await page.route('**/api/chat/handoff', (route) => {
  handoffBody = route.request().postDataJSON();
  return route.fulfill({
    json: {
      chatId: 'new-1',
      path: PROJECT.path,
      started: handoffBody.startRun === true,
      prompt: `Это новая сессия.\n${handoffBody.proposal.next}`,
      chainDepth: 2,
    },
  });
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

// Продолжать некуда, пока не открыт проект: каталог новой сессии неизвестен.
check(
  (await page
    .getByRole('button', { name: 'Закрыть этап и продолжить в чистой сессии' })
    .count()) === 0,
  'в песочнице кнопки продолжения нет',
);

// Список проектов живёт за сегментом «Проекты» — по умолчанию там чаты.
await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1200);
await page
  .getByRole('button', { name: /Продолжение этапа/ })
  .first()
  .click();
await page.waitForTimeout(1500);

const body = await page.textContent('body');
check(!body.includes('claude-control:handoff'), 'сырого блока в ленте нет');
check(!body.includes('"checkpoint"'), 'JSON предложения не показан как текст');
check(body.includes('Этап закрыт') && body.includes('Жду решения'), 'текст вокруг блока цел');
check(body.includes('Закрыт экспорт отчётов'), 'что закрыто — видно');
check(body.includes('Взяться за импорт'), 'задание новой сессии показано целиком');
check(body.includes('.agent/PROGRESS.md'), 'файл-опора назван');
check(body.includes('.agent/ARCHIVE.md'), 'вычищенное показано человеку');
check(body.includes('шаг 1 из 5'), 'номер шага цепочки и её потолок видны');

// Решение принимают только по последнему предложению: карточка из середины
// истории отработана, стирать по ней контекст десять ходов спустя незачем.
const apply = page.getByRole('button', { name: 'Продолжить в новом чате' });
check((await apply.count()) === 1, 'кнопки только у последнего предложения');

/** Пока идёт ход, карточка погашена: ждём конца хода, а не таймаута клика. */
const waitEnabled = async (locator) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await locator.count()) > 0 && (await locator.first().isEnabled())) return true;
    await page.waitForTimeout(250);
  }
  return false;
};

// Отказ — такой же ход, как согласие: уходит агенту обычной репликой.
await page.getByRole('button', { name: 'Остаться здесь' }).click();
await page.waitForTimeout(1500);
check(sent?.prompt?.includes('Не начинай новую сессию'), 'отказ ушёл репликой в тот же разговор');
check(handoffBody === undefined, 'отказ не заводит никакого разговора');
check((await apply.count()) === 0, 'после ответа предложение отработано: кнопок нет');

// Просьба закрыть этап задним числом: кнопка в поле ввода, текст — с сервера.
sent = undefined;
const ask = page.getByRole('button', { name: 'Закрыть этап и продолжить в чистой сессии' });
check(await waitEnabled(ask), 'у вкладки проекта кнопка продолжения есть');
await ask.click();
await page.waitForTimeout(1500);
check(
  sent?.prompt === 'Закрой этап и выведи блок claude-control:handoff.',
  'просьба ушла текстом сервера',
);
check(handoffBody === undefined, 'просьба ничего не заводит сама по себе');

// Согласие проверяем на свежей ленте: после наших реплик предложение перестало
// быть последним, а решают только по последнему.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1800);
check(await waitEnabled(apply), 'вкладка вернулась к тому же разговору с предложением');

// Автопродолжение включают в самой карточке — и включают у РАЗГОВОРА, а не
// глобально: тумблер уходит на сервер, потому что решать он будет и с закрытой
// вкладкой.
const auto = page.getByRole('switch', { name: 'Дальше продолжай сам' });
await waitEnabled(auto);
await auto.click();
await page.waitForTimeout(800);
check(autoBody?.enabled === true, 'тумблер автопродолжения ушёл на сервер');
check(handoffBody === undefined, 'сам по себе тумблер ничего не заводит');

// «Только завести чат»: разговор с готовым заданием, но без стартовавшего агента.
const createOnly = page.getByRole('switch', { name: 'Только завести чат, не запускать агента' });
await waitEnabled(createOnly);
await createOnly.click();
await page.waitForTimeout(200);
await waitEnabled(apply);
await apply.click();
await page.waitForTimeout(1500);

check(Boolean(handoffBody), 'согласие ушло на сервер');
check(handoffBody?.startRun === false, '«только завести чат» доехало до сервера');
check(handoffBody?.projectPath === PROJECT.path, 'каталог разговора передан');
check(handoffBody?.chatId === CHAT_ID, 'ключ закрываемого разговора передан — цепочка не рвётся');
check(handoffBody?.proposal?.next?.includes('импорт'), 'предложение ушло целиком');
check(
  (await page.getByText('Чат заведён — задание в поле ввода').count()) > 0,
  'о заведённом чате сказано человеку',
);
check(
  (await page.locator('textarea').first().inputValue()).includes('Это новая сессия'),
  'задание положено в поле ввода нового разговора',
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Продолжение в чистой сессии работает' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
