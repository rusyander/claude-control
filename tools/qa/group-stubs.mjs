/**
 * Подменённый API страницы групп — общий для `check-group-sources.mjs`,
 * `check-group-path.mjs`, обходов доступности/клавиатуры (`panel-pages.mjs`) и
 * снимков справки. Отвечает на всё, что страница групп спрашивает о группах:
 * список, находки обнаружения, выбор стороны пары, переопределение, копию в
 * общие, советы, путь, ассистента шага, числа скиллов, описания участников и
 * сводки ресурсов.
 *
 * Зачем подмена, а не стенд: настоящие находки требуют проектов на диске и
 * вызова модели, копия в общие пишет в настоящий ~/.claude, а ассистент шага —
 * это разговор с моделью. Проверка не имеет права ни от чего из этого зависеть
 * и ничего не оставляет после себя. Остальные запросы страницы (списки скиллов,
 * провайдеры, настройки) идут на стенд как есть.
 *
 * Состояние изменяемое: запись (PUT шагов, выбор стороны, импорт) меняет его,
 * и следующий GET отдаёт новое — так проверка видит результат жеста, а не
 * заранее нарисованную картинку. `calls` — журнал запросов на запись.
 */

/** Адреса, которые отвечает подмена; остальное идёт на стенд. */
export const STUBBED =
  /\/api\/(groups|automations|projects\/group-choice|resources\/summary)(\/|\?|$)/;

const NOW = '2026-09-26T09:00:00.000Z';
const SHOP = 'C:/work/shop';
const SITE = 'C:/work/site';
const PROJECT_SCOPE = { kind: 'project', path: SHOP, provider: 'claude' };

const line = (ru, en) => ({ ru, en });

/** Готовые ресурсы, как их отдаёт `GET /groups/resource-catalog`. */
const CATALOG = [
  {
    type: 'skill',
    id: 'e2e-runner',
    scope: 'global',
    title: line('Прогон e2e', 'E2E run'),
    summary: line(
      'гоняет e2e на стенде и прикладывает отчёт',
      'runs e2e on the stand, attaches the report',
    ),
  },
  {
    type: 'skill',
    id: 'release-notes',
    scope: 'global',
    title: line('Заметки к релизу', 'Release notes'),
    summary: line('собирает заметки из закрытых задач', 'collects notes from closed tasks'),
  },
  {
    type: 'rule',
    id: 'review-checklist',
    scope: 'global',
    title: line('Чек-лист ревью', 'Review checklist'),
    summary: line('что проверить перед MR', 'what to check before an MR'),
  },
  {
    type: 'hook',
    id: 'PostToolUse:7c1e',
    scope: 'global',
    title: line('после правки файла: линт', 'after a file edit: lint'),
    summary: line('запускает pnpm lint после правки', 'runs pnpm lint after an edit'),
  },
  { type: 'script', id: 'tools/shots.mjs', scope: 'project', description: 'снимает кадры' },
];

function baseGroup(patch) {
  return {
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    isEnabled: true,
    order: 0,
    ...patch,
  };
}

function step(id, anchor, order, title, prompt, extra = {}) {
  return {
    id,
    anchor,
    order,
    kind: 'prompt',
    title,
    prompt,
    source: 'ru',
    createdAt: NOW,
    ...extra,
  };
}

const BUILTIN = ['triage', 'plan', 'work', 'review', 'fix', 'deliver'];

/**
 * Путь, как его собрал бы сервер (`domains/groups/path/path.ts buildPath`): у
 * конвейера — стадия, затем шаги скилла и свои шаги этой стадии; у сценария
 * (`flow: 'scenario'`) — только свои шаги по порядку, без стадий и скиллов.
 */
function buildEntries(steps, skillSteps = [], flow) {
  if (flow === 'scenario') {
    return BUILTIN.flatMap((stage) =>
      steps
        .filter((entry) => entry.anchor === stage)
        .sort((left, right) => left.order - right.order)
        .map((step) => ({ kind: 'custom', step })),
    );
  }
  const entries = [];
  for (const stage of BUILTIN) {
    entries.push({ kind: 'builtin', stage });
    for (const item of skillSteps.filter((entry) => entry.after === stage)) {
      entries.push({
        kind: 'skill-step',
        skillId: item.skillId,
        index: item.index,
        title: item.title,
      });
    }
    for (const item of steps
      .filter((entry) => entry.anchor === stage)
      .sort((left, right) => left.order - right.order)) {
      entries.push({ kind: 'custom', step: item });
    }
  }
  return entries;
}

/**
 * `order` внутри стадии подряд с нуля в присланном порядке — как
 * `normalizePathSteps` сервера: без этого перенос в подмене давал путь, какого
 * сервер не вернёт никогда.
 */
function normalizeOrder(steps) {
  const counters = {};
  const orderOf = {};
  steps
    .map((step, position) => ({ step, position }))
    .sort((a, b) => a.step.order - b.step.order || a.position - b.position)
    .forEach(({ step }) => {
      orderOf[step.id] = counters[step.anchor] = (counters[step.anchor] ?? -1) + 1;
    });
  return steps.map((step) => ({ ...step, order: orderOf[step.id] }));
}

/** Сводки участников, которых кадры показывают рядом; прочие получают общую. */
const SUMMARIES = {
  'ticket-delivery': {
    ru: 'доводит тикет до MR: ветка, правка, проверки, описание.\nКак работает: идёт по своим шагам по порядку и на каждом ждёт «готово».',
    en: 'takes a ticket to an MR: branch, change, checks, description.\nHow: walks its steps in order and waits for “done” at each.',
  },
  'review-checklist': {
    ru: 'список того, что смотреть на ревью.\nКак работает: правило подгружается в каждый ход и держит ревью по пунктам.',
    en: 'the list of what to look at in review.\nHow: the rule loads into every turn and keeps the review point by point.',
  },
};

/**
 * То же состояние без находок: для снимков, где обнаружение не предмет кадра
 * (привязка, ручной набор), — иначе ход по источникам занимает пол-экрана.
 */
export function makeQuietGroupState() {
  const state = makeGroupState();
  state.discovery = {
    running: false,
    lastRunAt: state.discovery.lastRunAt,
    sources: [],
    groups: [],
  };
  return state;
}

/**
 * Сценарий (`flow: 'scenario'`) из `count` своих шагов — длинный путь для
 * переноса, прокрутки у края и 80 шагов, которые сценарий обязан держать.
 */
export function addScenarioGroup(
  state,
  { id = 'qa-scenario', name = 'Длинный сценарий', count = 80 } = {},
) {
  state.groups = [
    ...state.groups,
    baseGroup({
      id,
      name,
      description: 'Шаги по порядку, без стадий',
      flow: 'scenario',
      isEnabled: false,
      order: 9,
      usedIn: [],
    }),
  ];
  state.paths[id] = Array.from({ length: count }, (_, index) =>
    step(
      `sc-${index + 1}`,
      'work',
      index,
      { ru: `Действие номер ${index + 1}`, en: `Action ${index + 1}` },
      { ru: `Сделать действие ${index + 1}`, en: `Do action ${index + 1}` },
    ),
  );
  state.knobs[id] = { base: [], values: {} };
  return state;
}

/**
 * Группа доставки тикета, как живая: один скилл, в тексте 14 шагов, а описаны
 * 12 — модель потеряла хвост, и новое описание идёт (`pending: step:…`).
 * `unreadable` — ещё один скилл, чей файл занят: путь называет его, а не молчит.
 */
export function addDeliveryGroup(
  state,
  { id = 'qa-delivery', name = 'Доставка тикета', unreadable = false } = {},
) {
  const skillId = 'ticket-delivery';
  state.groups = [
    ...state.groups,
    baseGroup({
      id,
      name,
      description: 'Тикет от взятия в работу до MR',
      members: [{ kind: 'skill', id: skillId }],
      order: 8,
      usedIn: [],
    }),
  ];
  state.paths[id] = [];
  state.skillSteps[id] = Array.from({ length: 14 }, (_, index) => ({
    skillId,
    index,
    title: `Stage ${index + 1} of the ticket flow`,
    after: 'work',
  }));
  state.knobs[id] = { base: [], values: {} };
  state.memberViews = {
    ...state.memberViews,
    [id]: {
      groupId: id,
      members: [
        {
          kind: 'skill',
          id: skillId,
          description: 'Delivering a ticket end-to-end',
          title: line('Доставка тикета до MR', 'Ticket delivery to MR'),
          summary: line('Ведёт тикет от взятия до MR', 'Takes a ticket from claim to MR'),
        },
      ],
      steps: Array.from({ length: 12 }, (_, index) => ({
        skillId,
        index,
        title: line(`Этап ${index + 1} доставки`, `Delivery stage ${index + 1}`),
        summary: line(`Что делает этап ${index + 1}`, `What stage ${index + 1} does`),
      })),
      pending: [`step:${skillId}`],
    },
  };
  if (unreadable) state.unreadable = { ...state.unreadable, [id]: ['locked-skill'] };
  return state;
}

export function makeGroupState() {
  const project = baseGroup({
    id: 'qa-shop-order',
    name: 'Порядок задачи магазина',
    description: 'Как в магазине доводят тикет до MR: скилл порядка, правила ревью и хук линта.',
    scope: PROJECT_SCOPE,
    when: 'задача с номером тикета PROJ-',
    members: [
      { kind: 'skill', id: 'ticket-delivery', scope: PROJECT_SCOPE },
      { kind: 'rule', id: 'review-checklist', scope: PROJECT_SCOPE },
      { kind: 'hook', id: 'PostToolUse:lint', scope: PROJECT_SCOPE },
    ],
    order: 2,
    usedIn: [SHOP],
  });
  const copy = baseGroup({
    id: 'qa-shop-order-global',
    name: 'Порядок задачи (общий)',
    description: 'Глобальная копия порядка магазина: подходит любому проекту с тикетами.',
    origin: { scope: PROJECT_SCOPE, groupId: project.id, hash: 'h-origin', copiedAt: NOW },
    when: 'задача с номером тикета в любом проекте',
    members: [
      { kind: 'skill', id: 'ticket-delivery' },
      { kind: 'rule', id: 'review-checklist' },
    ],
    order: 1,
    originChanged: ['skill:ticket-delivery'],
    usedIn: [SHOP, 'C:/work/blog'],
  });
  const manual = baseGroup({
    id: 'qa-frontend',
    name: 'Фронтенд-работа',
    description: 'Набор под вёрстку: правила стиля и сервер браузера.',
    members: [{ kind: 'mcp', id: 'playwright' }],
    order: 0,
    usedIn: [],
  });
  const site = baseGroup({
    id: 'qa-site-docs',
    name: 'Документация сайта',
    scope: { kind: 'project', path: SITE, provider: 'claude' },
    members: [
      {
        kind: 'skill',
        id: 'docs-writer',
        scope: { kind: 'project', path: SITE, provider: 'claude' },
      },
    ],
    order: 3,
    usedIn: [SITE],
  });

  return {
    calls: [],
    groups: [manual, copy, project, site],
    choice: { [SHOP]: `global:${copy.id}` },
    paths: {
      [manual.id]: [
        step(
          's-lint',
          'review',
          0,
          { ru: 'Прогнать линт', en: 'Run lint' },
          { ru: 'Запусти линт и почини замечания.', en: 'Run the linter and fix findings.' },
        ),
      ],
      [copy.id]: [
        step(
          's-e2e',
          'review',
          0,
          { ru: 'Прогнать e2e', en: 'Run e2e' },
          { ru: 'Прогони e2e и приложи отчёт.', en: 'Run e2e and attach the report.' },
          { gate: { ru: 'отчёт e2e зелёный', en: 'e2e report is green' } },
        ),
        step(
          's-rel',
          'deliver',
          0,
          { ru: 'Заметки к релизу', en: 'Release notes' },
          { ru: '', en: '' },
          { kind: 'resource', resource: { type: 'skill', id: 'release-notes' } },
        ),
      ],
      [project.id]: [],
      [site.id]: [
        step(
          's-scope',
          'triage',
          0,
          { ru: 'Уточнить объём', en: 'Clarify scope' },
          {
            ru: 'Спроси, какие страницы входят в задачу.',
            en: 'Ask which pages the task covers.',
          },
        ),
        step(
          's-old',
          'work',
          0,
          { ru: 'Сверить с макетом', en: 'Сверить с макетом' },
          { ru: 'Сверь страницу с макетом.', en: 'Сверь страницу с макетом.' },
          { needsTranslation: true },
        ),
      ],
    },
    skillSteps: {
      [copy.id]: [
        {
          after: 'work',
          skillId: 'ticket-delivery',
          index: 0,
          title: 'Взять тикет и завести ветку',
        },
        { after: 'work', skillId: 'ticket-delivery', index: 1, title: 'Сделать и проверить' },
      ],
      [project.id]: [
        {
          after: 'work',
          skillId: 'ticket-delivery',
          index: 0,
          title: 'Взять тикет и завести ветку',
        },
      ],
    },
    // «Числа» групп: у скилла порядка тикета три числа, одно уже своё.
    // `pendingPolls` — сколько GET ответить «читаю скилл…», прежде чем отдать числа;
    // `fail` — группы, у которых чтение чисел падает (проверка кнопки «Повторить»).
    knobs: {
      [copy.id]: { base: TICKET_KNOBS, values: { 'ticket-delivery:review-rounds': 3 } },
      [project.id]: { base: TICKET_KNOBS, values: {} },
      [site.id]: { base: [], values: {} },
      [manual.id]: { base: [], values: {} },
    },
    knobsPendingPolls: 0,
    knobsFail: new Set(),
    // Каталог «Выбрать готовый»: первый ответ — ещё описывается, дальше — словами.
    catalog: CATALOG,
    catalogPolls: 0,
    // Сбои записи: `promoteFail` — повышение до хука отвергнуто сервером.
    promoteFail: false,
    discovery: {
      running: false,
      lastRunAt: NOW,
      sources: [
        { source: SHOP, state: 'cached', found: 1 },
        { source: SITE, state: 'done', found: 1 },
        { source: 'provider:claude', state: 'done', found: 1 },
        // Как у настоящего сервера: подробность как есть и код, который страница говорит словами.
        {
          source: 'provider:codex',
          state: 'failed',
          found: 0,
          error: 'CLI не ответил за отведённое время',
          errorCode: 'timeout',
        },
      ],
      groups: [
        {
          key: 'shop:release',
          // Как у настоящего сервера: строки — английская сторона, пара — в `localized`;
          // страница показывает сторону языка интерфейса.
          name: 'Store release',
          when: 'preparing a store release',
          why: 'the release skill calls the version rule and the tag hook in order',
          localized: {
            name: { ru: 'Выпуск релиза', en: 'Store release' },
            when: { ru: 'подготовка релиза магазина', en: 'preparing a store release' },
            why: {
              ru: 'скилл выпуска вызывает правило версий и хук тегов по порядку',
              en: 'the release skill calls the version rule and the tag hook in order',
            },
          },
          foundIn: SHOP,
          usedIn: [SHOP],
          members: [
            {
              kind: 'skill',
              id: 'release',
              path: `${SHOP}/.claude/skills/release/SKILL.md`,
              summary: 'Собирает релиз: версия, тег, заметки.',
            },
            {
              kind: 'rule',
              id: 'semver',
              path: `${SHOP}/.claude/rules/semver.md`,
              summary: 'Как поднимать версию.',
            },
          ],
          steps: [
            { title: 'Поднять версию', source: 'release' },
            { title: 'Поставить тег', source: 'release' },
          ],
          inventoryHash: 'inv-1',
          status: 'new',
        },
        {
          key: 'provider:claude:review',
          name: 'Строгое ревью',
          when: '',
          why: '',
          foundIn: 'provider:claude',
          usedIn: [],
          members: [
            {
              kind: 'skill',
              id: 'deep-review',
              path: '~/.claude/skills/deep-review/SKILL.md',
              summary: 'Ревью в несколько проходов.',
            },
          ],
          steps: [],
          inventoryHash: 'inv-2',
          status: 'new',
        },
        {
          key: 'shop:order',
          name: 'Порядок задачи магазина',
          when: '',
          why: '',
          foundIn: SHOP,
          usedIn: [SHOP],
          members: [],
          steps: [],
          inventoryHash: 'inv-3',
          status: 'imported',
        },
      ],
    },
    draftRound: 0,
  };
}

/** Числа скилла порядка тикета — с цитатой, откуда каждое взято. */
const TICKET_KNOBS = [
  {
    key: 'review-rounds',
    skillId: 'ticket-delivery',
    label: { ru: 'Кругов ревью', en: 'Review rounds' },
    default: 2,
    min: 1,
    max: 5,
    quote: 'Ревью идёт в 2 круга: второй проверяет правки первого.',
  },
  {
    key: 'agents-per-round',
    skillId: 'ticket-delivery',
    label: { ru: 'Агентов на круг', en: 'Agents per round' },
    default: 2,
    min: 1,
    max: 6,
    quote: 'На круг — 2 агента, у каждого своя полоса файлов.',
  },
  {
    key: 'verifiers',
    skillId: 'ticket-delivery',
    label: { ru: 'Проверяющих', en: 'Verifiers' },
    default: 1,
    min: 0,
    max: 3,
    quote: 'Итог подтверждает 1 проверяющий.',
  },
];

/** Вид чисел группы, как его собирает сервер: значение = своё или умолчание скилла. */
function knobsView(state, id) {
  const own = state.knobs[id] ?? { base: [], values: {} };
  if (state.knobsPendingPolls > 0) {
    state.knobsPendingPolls -= 1;
    return { groupId: id, knobs: [], pending: ['ticket-delivery'] };
  }
  return {
    groupId: id,
    knobs: own.base.map((knob) => {
      const key = `${knob.skillId}:${knob.key}`;
      // Как у сервера: есть запись — число закреплено (и равное умолчанию тоже), нет — «Авто».
      const stored = key in own.values;
      const value = stored ? own.values[key] : knob.default;
      return { ...knob, value, auto: !stored, overridden: value !== knob.default };
    }),
  };
}

const ADVICE = [
  {
    kind: 'skill',
    id: 'ticket-delivery',
    verdict: 'improve',
    reason: 'Шаг ветки завязан на путь магазина — обобщить.',
  },
  {
    kind: 'rule',
    id: 'review-checklist',
    verdict: 'ours',
    reason: 'Глобальный список ревью полнее и уже покрывает этот.',
    replacement: 'code-review',
  },
  {
    kind: 'hook',
    id: 'PostToolUse:lint',
    verdict: 'keep',
    reason: 'Хук проектный по сути: команда линта своя у каждого проекта.',
  },
  // Замена хука от модели — исполняемая команда: окно показывает её и не
  // отмечает заранее (ревью 28.09, F-06).
  {
    kind: 'hook',
    id: 'PreToolUse:format',
    verdict: 'improve',
    reason: 'Форматировать только изменённые файлы.',
    replacement: JSON.stringify({
      event: 'PreToolUse',
      matcher: 'Edit',
      command: 'npx prettier --write "$FILE"',
    }),
  },
];

/** Первый круг — вопросы и похожий ресурс; следующий — готовое предложение с «сделать скиллом». */
function draftAnswer(state, body) {
  state.draftRound += 1;
  if (body.mode === 'translate') {
    const text = body.text;
    const other = body.lang === 'ru' ? 'en' : 'ru';
    // Окно шлёт шаг целиком (`current`): переводится и условие готовности,
    // как у настоящего переводчика; без него окно перевод не примет.
    const gateFrom = body.current?.gate?.[body.lang];
    return {
      conversationId: 'conv-1',
      proposal: {
        similar: [],
        questions: [],
        // Название не переводим: пустая строка оставляет прежнее (так делает окно).
        title: { ru: '', en: '' },
        prompt: { ru: '', en: '', [other]: `(${other}) ${text}` },
        ...(gateFrom ? { gate: { ru: '', en: '', [other]: `(${other}) ${gateFrom}` } } : {}),
      },
    };
  }
  if (state.draftRound === 1) {
    return {
      conversationId: 'conv-1',
      proposal: {
        similar: [{ type: 'skill', id: 'e2e-runner', why: 'гоняет e2e и собирает отчёт' }],
        questions: ['На каком стенде гонять e2e?', 'Куда приложить отчёт?'],
        title: { ru: 'Прогнать e2e', en: 'Run e2e' },
        prompt: { ru: 'Прогони e2e.', en: 'Run e2e.' },
      },
    };
  }
  return {
    conversationId: 'conv-1',
    proposal: {
      similar: [],
      questions: [],
      title: { ru: 'Прогнать e2e на стенде', en: 'Run e2e on the stand' },
      prompt: {
        ru: 'Прогони e2e на локальном стенде и приложи отчёт к описанию MR.',
        en: 'Run e2e on the local stand and attach the report to the MR description.',
      },
      gate: { ru: 'отчёт e2e зелёный', en: 'e2e report is green' },
      // `state.draftMatch` — ассистент нашёл готовый ресурс, делающий ровно это.
      ...(state.draftMatch ? { match: state.draftMatch } : {}),
      promote: {
        type: 'skill',
        draft: '---\nname: e2e-on-stand\ndescription: Run e2e on the stand\n---\n\n1. Run e2e.\n',
      },
    },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Открыть окно группы (или находки) по имени: карточка в сетке — только
 * главное, путь и состав живут в окне. Щёлкаем по имени, ровно как человек.
 * Возвращает окно.
 */
export async function openGroup(page, name) {
  const button = page
    .getByRole('heading', { name, exact: true })
    .getByRole('button', { name, exact: true });
  await showTileOf(page, button);
  await button.click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.waitFor({ timeout: 8000 });
  return dialog;
}

/**
 * Карточки разложены по вкладкам (глобальные, в проектах, найденные): группа
 * на соседней вкладке не видна. Сначала ждём открытую вкладку, затем обходим
 * остальные — как человек, который ищет группу глазами.
 */
async function showTileOf(page, button) {
  const tabs = page.getByRole('tablist', { name: /^(Разделы групп|Group sections)$/ });
  // Дев-стенд перезапускается на правках других дорожек: страница посреди
  // обхода остаётся белой (обход клавиатуры 27.09 упал здесь). Один раз
  // перезагружаем — подмена `page.route` перезагрузку переживает; второй
  // таймаут — уже настоящий сбой страницы.
  const ready = await tabs.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false,
  );
  if (!ready) {
    console.log('инфо полоса вкладок групп не появилась за 15 с — перезагружаю страницу один раз');
    await page.reload();
    await tabs.waitFor({ timeout: 15000 });
  }
  const seen = (timeout) =>
    button.waitFor({ timeout }).then(
      () => true,
      () => false,
    );
  if (await seen(4000)) return;
  for (const tab of await tabs.getByRole('tab').all()) {
    await tab.click();
    if (await seen(1500)) return;
  }
  await button.waitFor({ timeout: 1000 });
}

/** Описания участников, как их отдаёт сервер: из файлов, без модели. */
function membersView(state, id) {
  const group = state.groups.find((item) => item.id === id);
  return {
    groupId: id,
    members: (group?.members ?? []).map((member) => {
      if (state.missingMembers?.has(`${member.kind}:${member.id}`)) {
        return { kind: member.kind, id: member.id, missing: true };
      }
      // Общего файла нет, но он в .claude привязанного проекта (живая группа владельца).
      const home = state.projectOnlyMembers?.get(`${member.kind}:${member.id}`);
      if (home) return { kind: member.kind, id: member.id, missing: true, foundIn: home };
      const known = SUMMARIES[member.id];
      return {
        kind: member.kind,
        id: member.id,
        description: known ? known.ru.split('\n')[0] : `${member.kind} «${member.id}» из файла`,
      };
    }),
  };
}

/**
 * Ставит подмену на странице. Вызывать ДО `page.goto`. `options.delay` —
 * задержка ответа по регулярке пути: так проверка видит промежуточное
 * состояние (идёт ассистент, грузится путь). `options.list === false` —
 * список групп и сценариев отдаётся предыдущей подмене страницы.
 */
export async function installGroupStubs(page, state = makeGroupState(), options = {}) {
  const pause = async (path) => {
    for (const [pattern, ms] of options.delay ?? []) {
      if (pattern.test(path)) await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };

  const handle = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    if (method !== 'GET') state.calls.push({ method, path, body });
    await pause(path);

    try {
      // Список групп и сценариев может держать чужая подмена (снимки справки
      // собирают группы в кадре своим состоянием) — тогда отдаём ей.
      if ((path === '/groups' || path === '/automations') && options.list === false) {
        return route.fallback();
      }
      // Сценарии живут на той же странице; их проверяют свои прогоны.
      if (path === '/automations' && method === 'GET') return json(route, []);
      if (path === '/groups' && method === 'GET') return json(route, state.groups);
      if (path === '/groups/discovery' && method === 'GET') return json(route, state.discovery);
      if (path === '/groups/discovery/run' && method === 'POST') {
        state.discovery = {
          ...state.discovery,
          running: true,
          sources: state.discovery.sources.map((item) => ({ ...item, state: 'running' })),
        };
        // Через пару опросов обнаружение «заканчивается» — страница должна это увидеть сама.
        setTimeout(() => {
          state.discovery = {
            ...state.discovery,
            running: false,
            lastRunAt: new Date().toISOString(),
            sources: makeGroupState().discovery.sources,
          };
        }, 2500);
        return json(route, { ok: true }, 202);
      }
      const importMatch = /^\/groups\/discovery\/([^/]+)\/import$/.exec(path);
      if (importMatch && method === 'POST') {
        const key = decodeURIComponent(importMatch[1]);
        const found = state.discovery.groups.find((item) => item.key === key);
        found.status = 'imported';
        // Как у настоящего сервера: имя и «Когда» — на языке, который прислала страница.
        state.importBodies = [...(state.importBodies ?? []), body ?? {}];
        const lang = body?.lang;
        const group = baseGroup({
          id: `imported-${state.groups.length}`,
          name: (lang && found.localized?.name[lang]) || found.name,
          when: (lang && found.localized?.when[lang]) || found.when,
          scope: { kind: 'project', path: found.foundIn, provider: 'claude' },
          order: state.groups.length,
          usedIn: found.usedIn,
          // Как у настоящего сервера: импорт не включает группу и не берёт «почему» в описание.
          isEnabled: false,
          description: '',
        });
        state.groups = [...state.groups, group];
        state.paths[group.id] = [];
        return json(route, group);
      }
      if (path === '/projects/group-choice' && method === 'GET') {
        return json(route, { groupKey: state.choice[url.searchParams.get('path')] ?? null });
      }
      if (path === '/projects/group-choice' && method === 'PUT') {
        state.choice[body.path] = body.groupKey;
        return json(route, { groupKey: body.groupKey });
      }
      if (path === '/resources/summary' && method === 'GET') {
        const id = url.searchParams.get('id');
        // Сводка своя у каждого ресурса: одинаковый текст у двух участников
        // выглядел бы в кадре как ошибка страницы, а не подмены.
        const known = SUMMARIES[id];
        return json(route, {
          hash: `h-${id}`,
          ru: `«${id}» — что делает: ${known?.ru ?? 'собирает заметки к релизу из закрытых задач.\nКак работает: читает историю и пишет раздел в CHANGELOG.'}`,
          en: `«${id}» — what it does: ${known?.en ?? 'collects release notes from closed tasks.\nHow: reads history and writes a CHANGELOG section.'}`,
        });
      }

      if (path === '/groups/resource-catalog' && method === 'GET') {
        state.catalogPolls += 1;
        if (state.catalogPolls === 1) {
          // Первый ответ: описания ещё идут — имена без слов, остальное в `pending`.
          return json(route, {
            items: state.catalog.map(({ title: _title, summary: _summary, ...rest }) => rest),
            pending: state.catalog.map((item) => `${item.type}:${item.id}`),
          });
        }
        return json(route, { items: state.catalog });
      }
      if (path === '/groups' && method === 'POST') {
        if (!body?.name?.trim()) return json(route, { error: 'Нужно имя группы' }, 400);
        const created = baseGroup({
          ...body,
          id: `created-${state.groups.length}`,
          order: state.groups.length,
        });
        state.groups = [...state.groups, created];
        state.paths[created.id] = [];
        state.knobs[created.id] = { base: [], values: {} };
        return json(route, created);
      }

      const groupMatch = /^\/groups\/([^/]+)(\/.*)?$/.exec(path);
      if (groupMatch) {
        const [, id, rest = ''] = groupMatch;
        const group = state.groups.find((item) => item.id === id);
        if (rest === '' && method === 'PUT') {
          const next = { ...group, ...body, id };
          state.groups = state.groups.map((item) => (item.id === id ? next : item));
          return json(route, next);
        }
        if (rest === '/members' && method === 'GET') {
          return json(route, state.memberViews?.[id] ?? membersView(state, id));
        }
        if (rest === '/enabled' && method === 'POST') {
          state.groups = state.groups.map((item) =>
            item.id === id ? { ...item, isEnabled: body.isEnabled } : item,
          );
          return json(route, { ok: true, affected: group?.members.length ?? 0 });
        }
        if (rest === '/knobs' && method === 'GET') {
          if (state.knobsFail.has(id)) return json(route, { error: 'не прочитано' }, 500);
          return json(route, knobsView(state, id));
        }
        if (rest === '/knobs' && method === 'PUT') {
          const own = (state.knobs[id] ??= { base: [], values: {} });
          for (const [key, value] of Object.entries(body.values)) {
            if (value === null) delete own.values[key];
            else own.values[key] = value;
          }
          return json(route, knobsView(state, id));
        }
        const flowOf = () => state.groups.find((item) => item.id === id)?.flow;
        if (rest === '/path' && method === 'GET') {
          return json(route, {
            groupId: id,
            entries: buildEntries(state.paths[id] ?? [], state.skillSteps[id], flowOf()),
            ...(state.unreadable?.[id] ? { unreadable: state.unreadable[id] } : {}),
          });
        }
        if (rest === '/path/steps' && method === 'PUT') {
          state.paths[id] = normalizeOrder(body.steps);
          if (state.saveDelay) await new Promise((done) => setTimeout(done, state.saveDelay));
          return json(route, {
            groupId: id,
            entries: buildEntries(state.paths[id], state.skillSteps[id], flowOf()),
          });
        }
        if (rest === '/path/draft' && method === 'POST')
          return json(route, draftAnswer(state, body));
        if (rest === '/path/promote' && method === 'POST') {
          if (state.promoteFail) return json(route, { error: 'хук не создан' }, 500);
          // Хук получает id «Событие:хэш», как настоящий; остальное — имя файла.
          const resourceId =
            body.type === 'hook' ? `${JSON.parse(body.draft).event}:9f3a` : 'e2e-on-stand';
          state.paths[id] = (state.paths[id] ?? []).map((item) =>
            item.id === body.stepId
              ? { ...item, kind: 'resource', resource: { type: body.type, id: resourceId } }
              : item,
          );
          return json(route, {
            groupId: id,
            entries: buildEntries(state.paths[id], state.skillSteps[id], flowOf()),
          });
        }
        // «Копировать группу»: как сервер — новая запись выключенной, шаги с новыми id,
        // числа и «Когда» с собой, без привязки к проектам.
        if (rest === '/duplicate' && method === 'POST') {
          const copy = baseGroup({
            ...group,
            id: `${id}-copy-${state.groups.length}`,
            name: body.name,
            projectPaths: [],
            isEnabled: false,
            order: state.groups.length,
            usedIn: [],
          });
          delete copy.origin;
          state.groups = [...state.groups, copy];
          state.paths[copy.id] = (state.paths[id] ?? []).map((item, index) => ({
            ...item,
            id: `${copy.id}-s${index}`,
          }));
          state.skillSteps[copy.id] = state.skillSteps[id];
          state.knobs[copy.id] = structuredClone(state.knobs[id] ?? { base: [], values: {} });
          return json(route, { group: copy, sourceId: id });
        }
        if (rest === '/copy-to-global' && method === 'POST') {
          const created = baseGroup({
            id: `${id}-global`,
            name: `${group.name} (общий)`,
            origin: { scope: group.scope, groupId: id, hash: 'h', copiedAt: NOW },
            members: group.members.map(({ kind, id: memberId }) => ({ kind, id: memberId })),
            order: state.groups.length,
            usedIn: [group.scope.path],
          });
          state.groups = [...state.groups, created];
          state.paths[created.id] = [];
          state.choice[group.scope.path] = `global:${created.id}`;
          return json(route, {
            group: created,
            advice: ADVICE,
            warnings: [
              {
                kind: 'renamed',
                member: 'rule:review-checklist',
                to: 'review-checklist-2',
                detail: '',
              },
            ],
          });
        }
        if (rest === '/merge-origin' && method === 'POST')
          return json(route, { group, advice: [...ADVICE.slice(0, 2), ADVICE[3]] });
        if (rest === '/advice/apply' && method === 'POST') {
          state.groups = state.groups.map((item) =>
            item.id === id ? { ...item, originChanged: [] } : item,
          );
          return json(
            route,
            state.groups.find((item) => item.id === id),
          );
        }
        if (rest === '/override' && method === 'PUT') {
          return json(route, {
            enabled: body.enabled,
            file: '.claude/rules/agentdeck-group.local.md',
          });
        }
      }
      // Запись в группы, которую подмена не знает, до настоящего сервера не
      // доходит: он пишет в конфигурацию человека. Снимки справки
      // (`list: false`) держат свои подмены записи — им отдаём.
      if (
        method !== 'GET' &&
        /^\/(groups|automations)(\/|$)/.test(path) &&
        options.list !== false
      ) {
        return json(route, { error: `подмена не знает ${method} ${path}` }, 501);
      }
      // Не наш адрес — отдать следующей подмене (снимки справки держат список
      // групп своим состоянием); нет её — запрос уходит на сервер как есть.
      return route.fallback();
    } catch (error) {
      // Страница закрылась раньше ответа — отвечать некому, это не отказ проверки.
      if (!String(error).includes('closed')) throw error;
      return undefined;
    }
  };

  await page.route(STUBBED, handle);
  return state;
}
