/**
 * Группа и автономность чата, автовыбор и заметки главному чату — живой UI на
 * подменённом API.
 *
 * Что проверяется (и что ломалось бы тихо):
 * - меню шапки ребёнка показывает группу и галочку «Автономно» унаследованными
 *   от родителя, со строкой «из родителя: …»; щелчок пишет ТОЛЬКО своё у чата —
 *   тело PUT без унаследованного поля;
 * - вопрос, закрытый автовыбором, — приглушённая строка «Автовыбор: …», а не
 *   карточка с кнопками, которую можно «ответить» второй раз;
 * - блок `agentdeck:escalate` в ответе ребёнка не показывается сырым JSON;
 * - у главного чата — карточка заметки со ссылкой на ребёнка и метка в списке;
 *   само открытие чата заметку НЕ гасит (открыть — не разобраться), гасит
 *   «Прочитано» (POST read): карточка и метка уходят;
 * - ребёнок разделения в git-копии видит проектные группы ОСНОВНОЙ копии:
 *   унаследованная проектная группа — своим именем, а не «Нет в списке» (F-78);
 * - негатив: сервер без маршрута выбора стороны пары (404) и упавший GET
 *   настроек не роняют меню — оно открывается, галочка недоступна и НЕ
 *   нарисована включённой: состояние неизвестно (F-182);
 * - тумблер и выбор группы подряд, пока запись тумблера ещё в полёте: вторая
 *   запись несёт и новый тумблер, а не откатывает его (F-181);
 * - из пары «проектная группа — её глобальная копия» меню предлагает только
 *   действующую в проекте сторону; закреплённая раньше другая сторона видна
 *   своей строкой «другая сторона пары», а не молча «Авто» (F-107).
 *
 * Данные подменены целиком (page.route): разговор с деревом, автовыбором и
 * заметкой в чужой истории — случайность, а прогон обязан повторяться.
 *
 * Запуск: `node tools/qa/check-chat-group-settings.mjs` при поднятом `pnpm dev`.
 * `--shots <TAG>` — снимки в `.agent/screenshots/before-after/chat-group-autonomy/`
 * (`<кадр>_<TAG>.png`) и выход без проверок: так снимается «до» на старом коде.
 * `SHOTS=<каталог>` — снимки кадров самих проверок (гонка записи, упавший GET).
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const ROOT = 'qa-group-root';
const KID = 'qa-group-kid';
// Ребёнок в git-копии: каталог чата — копия, основная копия — в сводке.
const WT_KID = 'qa-group-kid-worktree';
const argv = process.argv.slice(2);
const shotsTag = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : undefined;
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(repo, '.agent', 'screenshots', 'before-after', 'chat-group-autonomy');
const theme = process.env.QA_THEME ?? 'light';
const checkShots = process.env.SHOTS;

const ESCALATE = [
  'Сделал миграцию.',
  '```agentdeck:escalate',
  '{"severity":"critical","text":"Миграция удалит колонку с данными клиентов"}',
  '```',
].join('\n');

const QUESTION = {
  questions: [
    {
      question: 'Как переносить данные?',
      header: 'Перенос',
      multiSelect: false,
      options: [
        { label: 'Одним скриптом', description: 'Быстро.' },
        { label: 'Партиями (Recommended)', description: 'Без простоя.' },
      ],
    },
  ],
};

const chat = (id, title, extra = {}) => ({
  id,
  title,
  project: 'qa',
  // Чат в панели: вкладка «Чат» списка показывает именно их, чаты проектов —
  // под своими проектами на соседней вкладке.
  projectPath: 'C:/qa-project',
  isSandbox: true,
  messageCount: 2,
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:05:00.000Z',
  preview: '',
  ...extra,
});

const CHATS = [
  chat(ROOT, 'Главный чат'),
  chat(KID, 'Группа API', { parentId: ROOT }),
  chat(WT_KID, 'Группа UI', {
    parentId: ROOT,
    projectPath: 'C:/qa-project.worktrees/ui',
    homeProjectPath: 'C:/qa-project',
    // Чат проекта: у песочницы меню проектных групп не показывает вовсе.
    isSandbox: false,
  }),
];

const MESSAGES = {
  [ROOT]: [
    { id: 'r1', role: 'user', blocks: [{ type: 'text', text: 'Разбей работу' }] },
    { id: 'r2', role: 'assistant', blocks: [{ type: 'text', text: 'Разделил на группы.' }] },
  ],
  [KID]: [
    { id: 'k1', role: 'user', blocks: [{ type: 'text', text: 'Сделай миграцию' }] },
    {
      id: 'k2',
      role: 'assistant',
      blocks: [
        {
          type: 'tool',
          name: 'AskUserQuestion',
          input: JSON.stringify(QUESTION),
          autoPicks: [{ question: 'Как переносить данные?', label: 'Партиями (Recommended)' }],
        },
        { type: 'text', text: ESCALATE },
      ],
    },
  ],
};

const GROUPS = [
  {
    id: 'g1',
    name: 'Ревью строгое',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: true,
    order: 0,
  },
  {
    id: 'pg',
    name: 'Ревью проекта',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: true,
    order: 1,
    // Обратные слэши и регистр — как Windows пишет каталог группы.
    scope: { kind: 'project', path: 'c:\\qa-project\\' },
  },
  {
    // Копия проектной группы для другой CLI: чату Claude не годится (F-40).
    id: 'pg-qwen',
    name: 'Ревью проекта для qwen',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: false,
    order: 2,
    scope: { kind: 'global', provider: 'qwen' },
  },
  {
    // Глобальная копия проектной `pg` в Claude — вторая сторона пары (F-107).
    id: 'pg-copy',
    name: 'Копия ревью проекта',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: true,
    order: 3,
    origin: {
      scope: { kind: 'project', path: 'C:/qa-project', provider: 'claude' },
      groupId: 'pg',
      hash: 'h',
      copiedAt: '2026-09-26T10:00:00.000Z',
    },
  },
];

const SETTINGS = {
  [ROOT]: {
    groupChoice: 'global:g1',
    groupChoiceInherited: false,
    autonomous: true,
    autonomousInherited: false,
  },
  [KID]: {
    groupChoice: 'global:g1',
    groupChoiceInherited: true,
    autonomous: true,
    autonomousInherited: true,
    parentChatId: ROOT,
  },
  [WT_KID]: {
    groupChoice: 'project:pg',
    groupChoiceInherited: true,
    autonomous: true,
    autonomousInherited: true,
    parentChatId: ROOT,
  },
};

const state = {
  read: false,
  puts: [],
  reads: 0,
  settingsFail: false,
  // Задержка ответа PUT: гонка «тумблер → выбор группы» в полёте первой записи.
  putDelay: 0,
  // Выбор сторон пар проекта; null — сервер без маршрута (404, негатив F-182).
  pairChoice: null,
};

const escalations = () => ({
  chats: {
    [ROOT]: [
      {
        id: `${KID}:x1`,
        childChatId: KID,
        childTitle: 'Группа API',
        text: 'Миграция удалит колонку с данными клиентов',
        source: 'block',
        at: '2026-09-26T10:04:00.000Z',
        read: state.read,
      },
    ],
  },
});

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1500, height: 1000 },
  colorScheme: theme === 'dark' ? 'dark' : 'light',
});
await bypassOnboarding(page);
const errors = [];
page.on('response', (response) => {
  if (process.env.QA_DEBUG && response.status() >= 500)
    console.log(response.status(), response.url());
});
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

const json = (route, body, status = 200) => route.fulfill({ status, json: body });
await page.route('**/api/chats', (route) => json(route, CHATS));
await page.route('**/api/chats/*/messages*', (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
  const messages = (MESSAGES[id] ?? []).map((m, index) => ({
    timestamp: `2026-09-26T10:0${index}:00.000Z`,
    ...m,
  }));
  return json(route, { messages, total: messages.length, hasMore: false });
});
await page.route('**/api/chat/active', (route) => json(route, []));
await page.route('**/api/chat/*/progress*', (route) =>
  json(route, { steps: [], isComplete: false }),
);
await page.route('**/api/chat/*/artifacts*', (route) => json(route, []));
await page.route('**/api/groups', (route) => json(route, GROUPS));
// Чат проекта спрашивает пульт git своего каталога — каталога нет на диске,
// стенд ответил бы 400; экрану групп пульт не нужен.
await page.route('**/api/project-git*', (route) =>
  json(route, { isRepo: false, detached: false, unborn: false, branches: [], changes: [] }),
);
await page.route('**/api/project-git/split-settings*', (route) =>
  json(route, {
    deliver: true,
    parallel: 8,
    parallelAuto: true,
    profile: {
      enabled: false,
      repo: false,
      remote: false,
      bootstrapConfigured: false,
      heavy: false,
    },
    permissions: {},
    permissionsOwn: [],
  }),
);
// Негатив: сервер без маршрута выбора стороны пары — меню обязано жить.
await page.route('**/api/projects/group-choice*', (route) =>
  state.pairChoice ? json(route, state.pairChoice) : json(route, { error: 'nf' }, 404),
);
await page.route('**/api/chat/escalations', (route) => json(route, escalations()));
await page.route('**/api/chat/*/escalations/read*', (route) => {
  state.read = true;
  state.reads += 1;
  return json(route, { ok: true, changed: true });
});
await page.route('**/api/chat/*/group-settings*', async (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
  if (route.request().method() === 'PUT') {
    const body = route.request().postDataJSON();
    const projectPath = new URL(route.request().url()).searchParams.get('projectPath');
    state.puts.push({ id, body, projectPath });
    const base = SETTINGS[id];
    SETTINGS[id] = {
      ...base,
      ...(body.autonomous !== undefined
        ? { autonomous: body.autonomous, autonomousInherited: false }
        : {}),
      ...(body.groupChoice !== undefined
        ? { groupChoice: body.groupChoice, groupChoiceInherited: false }
        : {}),
    };
    const answer = SETTINGS[id];
    if (state.putDelay > 0) await new Promise((resolve) => setTimeout(resolve, state.putDelay));
    return json(route, answer);
  }
  if (state.settingsFail) return json(route, { error: 'boom' }, 500);
  return json(route, SETTINGS[id] ?? SETTINGS[ROOT]);
});

let bad = 0;
const rows = [];
const check = (ok, text) => {
  rows.push(`${ok ? 'ок   ' : 'ПЛОХО'} ${text}`);
  console.log(`${ok ? 'ок   ' : 'ПЛОХО ×'} ${text}`);
  if (!ok) bad += 1;
};
const shot = async (name) => {
  if (!shotsTag) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}_${shotsTag}.png`) });
};
const snap = async (name) => {
  if (!checkShots) return;
  mkdirSync(checkShots, { recursive: true });
  await page.screenshot({ path: join(checkShots, `${name}.png`) });
};
const row = (title) => page.getByRole('button', { name: new RegExp(title) }).first();
const openMenu = async () => {
  await page.getByRole('button', { name: 'Настройки чата' }).first().click();
  await page.waitForTimeout(400);
};
const closeMenu = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
};

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);

// --- Список: точка у главного чата до открытия ---
const badge = page.locator(`[data-chat-escalations]`);
if (!shotsTag) {
  check(
    (await badge.count()) === 1,
    `метка непрочитанной заметки в списке: ${await badge.count()}`,
  );
}

// --- Главный чат: карточка заметки, прочтение ---
await row('Главный чат').click();
await page.waitForTimeout(1500);
await shot('root-feed');
if (!shotsTag) {
  const card = page.locator('[data-escalation-notice]');
  check((await card.count()) === 1, `карточка заметки в главном чате: ${await card.count()}`);
  check(
    await card.getByText('Миграция удалит колонку с данными клиентов').isVisible(),
    'в карточке текст ребёнка',
  );
  check(
    state.reads === 0,
    `открытие главного чата заметку не прочитало (POST read: ${state.reads})`,
  );
  check((await badge.count()) === 1, 'метка в списке держится, пока заметку не прочли');
}
await openMenu();
await shot('root-menu');
if (!shotsTag) {
  const select = page.getByRole('combobox', { name: 'Группа' });
  check((await select.count()) === 1, 'в меню есть выбор «Группа»');
  check(
    (await select.inputValue()) === 'global:g1',
    `у главного чата своя группа: ${await select.inputValue()}`,
  );
  check(
    (await page.getByText('из родителя', { exact: false }).count()) === 0,
    'у главного чата нет строки «из родителя»',
  );
}
await closeMenu();

// --- Ребёнок: автовыбор, спрятанный блок, наследование в меню ---
if (shotsTag) {
  await row('Группа API').click();
} else {
  await page.locator('[data-escalation-notice]').getByRole('button').first().click();
}
await page.waitForTimeout(1500);
await shot('kid-feed');
if (!shotsTag) {
  check(
    await page.getByText('Автовыбор: Партиями (Recommended)').isVisible(),
    'строка «Автовыбор: …» в ленте ребёнка (переход по ссылке карточки)',
  );
  check(
    (await page.getByRole('button', { name: /Одним скриптом/ }).count()) === 0,
    'закрытый автовыбором вопрос не отвечаем',
  );
  check(
    (await page.getByText('agentdeck:escalate').count()) === 0 &&
      (await page.getByText('"severity"', { exact: false }).count()) === 0,
    'блок замечания не показан сырым JSON',
  );
  check(await page.getByText('Сделал миграцию.').isVisible(), 'текст ответа вокруг блока на месте');
}
await openMenu();
await shot('kid-menu');
if (!shotsTag) {
  const auto = page.getByRole('switch', { name: /Автономно/ });
  check((await auto.count()) === 1, 'галочка «Автономно — выбирать рекомендованное»');
  check(await auto.isChecked(), 'галочка включена (от родителя)');
  // Обе настройки унаследованы — строка стоит под каждой: одна на двоих не
  // сказала бы, какая из них своя.
  const inherited = await page.getByText(/из родителя: Главный чат/).count();
  check(
    inherited === 2,
    `строка «из родителя: Главный чат» под группой и под автономией: ${inherited}`,
  );
  await auto.click();
  await page.waitForTimeout(500);
  const last = state.puts.at(-1);
  check(
    last?.id === KID && JSON.stringify(last.body) === JSON.stringify({ autonomous: false }),
    `щелчок у ребёнка пишет только своё: ${JSON.stringify(last)}`,
  );
  check(!(await auto.isChecked()), 'галочка выключилась');

  // F-181: тумблер и сразу выбор группы, пока запись тумблера в полёте. Каждая
  // запись — полная замена своего у чата; вторая, собранная из вида ДО ответа
  // первой, несла старое «Автономно» и откатывала только что включённое.
  state.putDelay = 1500;
  const before = state.puts.length;
  await auto.click();
  await page.waitForTimeout(150);
  await page.getByRole('combobox', { name: 'Группа' }).selectOption('auto');
  await page.waitForTimeout(3500);
  state.putDelay = 0;
  const race = state.puts.slice(before);
  check(
    race.length === 2 && race[1].body.autonomous === true && race[1].body.groupChoice === 'auto',
    `выбор группы в полёте записи тумблера не откатывает тумблер: ${JSON.stringify(race.map((put) => put.body))}`,
  );
  check(await auto.isChecked(), 'после обоих ответов галочка включена');
  await snap('race-toggle-then-group');
  await closeMenu();

  // Ребёнок в git-копии: проектная группа основной копии — в списке своим именем.
  // Чат проекта живёт на соседней вкладке списка — открываем ссылкой.
  await page.goto(`${BASE}/chat?id=${WT_KID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1500);
  await openMenu();
  const wtSelect = page.getByRole('combobox', { name: 'Группа' });
  check(
    (await wtSelect.inputValue()) === 'project:pg',
    `ребёнок в git-копии наследует проектную группу: ${await wtSelect.inputValue()}`,
  );
  const wtLabels = await wtSelect.locator('option').allTextContents();
  check(
    wtLabels.includes('Ревью проекта (проект)') &&
      !wtLabels.some((l) => l.startsWith('Нет в списке')),
    `проектная группа основной копии в списке ребёнка: ${wtLabels.join(' | ')}`,
  );
  check(
    !wtLabels.includes('Ревью проекта для qwen'),
    `копии группы для другой CLI нет в списке чата Claude: ${wtLabels.join(' | ')}`,
  );
  // F-107: выбора пары нет — действует проектная сторона, копию закрепить нельзя.
  check(
    !wtLabels.includes('Копия ревью проекта'),
    `неактивной глобальной стороны пары нет в списке: ${wtLabels.join(' | ')}`,
  );
  await snap('pair-project-side');
  // F-107: у черновика транскрипта нет — проект для отказа неактивной стороне
  // сервер знает только из запроса. Запись из git-копии несёт основную копию.
  const wtBefore = state.puts.length;
  await page.getByRole('switch', { name: /Автономно/ }).click();
  await page.waitForTimeout(500);
  const wtPut = state.puts.slice(wtBefore).at(-1);
  check(
    wtPut?.id === WT_KID && wtPut.projectPath === 'C:/qa-project',
    `запись настроек несёт проект основной копии: ${JSON.stringify(wtPut)}`,
  );
  await closeMenu();

  // Проект выбрал глобальную сторону: копия в списке, проектная — нет, а уже
  // закреплённая проектная названа строкой «другая сторона пары».
  state.pairChoice = { groupKey: 'global:pg-copy', choices: { pg: 'global:pg-copy' } };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1500);
  await openMenu();
  const pairSelect = page.getByRole('combobox', { name: 'Группа' });
  const pairLabels = await pairSelect.locator('option').allTextContents();
  check(
    pairLabels.includes('Копия ревью проекта') && !pairLabels.includes('Ревью проекта (проект)'),
    `выбрана глобальная сторона — в списке копия, проектной нет: ${pairLabels.join(' | ')}`,
  );
  check(
    (await pairSelect.inputValue()) === 'project:pg' &&
      pairLabels.some((l) => l.includes('другая сторона пары') && l.includes('Ревью проекта')),
    `закреплённая неактивная сторона видна своей строкой: ${pairLabels.join(' | ')}`,
  );
  await snap('pair-global-side');
  await closeMenu();
  state.pairChoice = null;

  // «Прочитано» в главном чате гасит и карточку, и метку списка.
  await row('Главный чат').click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Прочитано' }).click();
  await page.waitForTimeout(800);
  check(state.reads === 1, `«Прочитано» — один POST read: ${state.reads}`);
  check((await page.locator('[data-escalation-notice]').count()) === 0, 'карточка ушла');
  check((await badge.count()) === 0, 'метка в списке погасла');

  // Негатив: GET настроек упал — меню открывается, галочка недоступна.
  // Перезагрузка — иначе вид берётся из кэша запросов и GET не повторяется.
  state.settingsFail = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  // Ждём состояния, а не фиксированных пауз: в прогоне группы под нагрузкой
  // список после перезагрузки поднимался дольше 1,2 с, и меню открывалось у
  // другого чата — три строки краснели при исправном продукте.
  await row('Группа API').waitFor({ timeout: 30_000 });
  await row('Группа API').click();
  await page.waitForTimeout(1200);
  await openMenu();
  // Секция запрашивает вид при открытии меню, и запрос повторяется один раз.
  await page
    .getByText('Настройки чата не загрузились', { exact: false })
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  check(
    await page.getByText('Настройки чата не загрузились', { exact: false }).isVisible(),
    'GET настроек 500 — в меню сказано, что настройки не загрузились',
  );
  const broken = page.getByRole('switch', { name: /Автономно/ });
  check(
    (await broken.count()) === 1 && (await broken.isDisabled()),
    'GET настроек 500 — меню живо, галочка недоступна',
  );
  // F-182: состояние неизвестно — включённой галочка рисоваться не должна.
  check(
    (await broken.count()) === 1 && !(await broken.isChecked()),
    'GET настроек 500 — галочка не нарисована включённой',
  );
  await snap('settings-get-failed');
  await closeMenu();
}

// 500 и 404 из негативов (упавший GET настроек, сервер без маршрута выбора
// пары) — ожидаемые строки консоли браузера, не ошибка страницы.
// 502 — неподменённые запросы в сервер стенда, пока тот перезапускается от
// чужих правок (`tsx watch`): к этому экрану отношения не имеют.
const unexpected = errors.filter((text) => !/status of (500|502|404)/.test(text));
if (unexpected.length > 0 && !shotsTag) {
  check(false, `ошибки консоли: ${unexpected.slice(0, 3).join(' | ')}`);
}
await browser.close();
if (shotsTag) {
  console.log(`снимки: ${SHOTS} (${shotsTag})`);
} else {
  console.log(`\nитог: ${rows.length - bad}/${rows.length}`);
  process.exit(bad === 0 ? 0 : 1);
}
