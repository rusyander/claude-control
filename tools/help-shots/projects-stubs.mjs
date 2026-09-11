/**
 * Общие заглушки для съёмки разделов «Проекты» и «Группы».
 *
 * Правило то же, что у прогонов `tools/qa/check-*.mjs`: подменяется ОТВЕТ
 * сервера, а не разметка. Экраны, подписи и счётчики в кадре настоящие — ровно
 * те, что человек увидит у себя; выдуманы только данные, за которыми иначе
 * пришлось бы держать на диске репозиторий с собственным `.claude`, реестр
 * проектов в чужом состоянии панели и живые группы поверх настоящего
 * `~/.claude`.
 *
 * ЗАГЛУШКА ЗДЕСЬ СО СВОЕЙ ПАМЯТЬЮ, а не таблица готовых ответов. Половина того,
 * что описывает раздел «Группы», — это ПОСЛЕДСТВИЕ действия: щёлкнули тумблер
 * группы — правило уехало в «Отключённые», сохранили сценарий — в хуках
 * появилась скомпилированная запись. Отдать такой кадр готовым состоянием
 * значило бы показать человеку экран, до которого он в панели никак не дошёл
 * бы. Поэтому состояние живёт в `makeState()`, а обработчики его меняют теми же
 * правилами, что и сервер: групповая отметка отдельно от ручной, участник
 * оживает только когда сняты обе.
 *
 * Имена файлов и путей подобраны без доменов первого уровня: опись кадра
 * проходит через `tools/qa/check-help-shots.mjs`, и `что-то.dev` в тексте он
 * считает чужим хостом — справедливо, отличить его от настоящего контура
 * заказчика по тексту нельзя.
 */

/** Проект, вокруг которого идёт весь путеводитель. Каталога на диске нет. */
export const PROJECT = {
  id: 'prj-shop-front',
  name: 'Витрина магазина',
  path: 'C:/work/shop-front',
};

/** Второй проект — он нужен только списку привязки: выбор из одного не выбор. */
export const PROJECT2 = {
  id: 'prj-shop-admin',
  name: 'Админка магазина',
  path: 'C:/work/shop-admin',
};

/** CLAUDE.md проекта: то, что панель показывает на вкладке «Правила». */
export const PROJECT_RULES = [
  '# Витрина магазина',
  '',
  'Магазин на React и Vite. Отвечай по-русски, правки делай точечные.',
  '',
  '## Проверки перед сдачей',
  '',
  '- `pnpm type-check && pnpm lint && pnpm test`',
  '- Снимки до и после — для любой правки, которую видно глазами.',
  '',
  '## Чего не делать',
  '',
  '- Не трогать каталог `migrations/`: им владеет команда бэкенда.',
  '',
].join('\n');

/** MCP-серверы проекта — его корневой `.mcp.json`. */
export const PROJECT_MCP = [
  {
    id: 'catalog-mock',
    name: 'catalog-mock',
    transport: 'stdio',
    command: 'node',
    args: ['tools/mcp/catalog.mjs'],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
  },
  {
    id: 'design-mocks',
    name: 'design-mocks',
    transport: 'http',
    url: 'http://127.0.0.1:4010/mcp',
    args: [],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
  },
];

/** Права проекта — его `.claude/settings.json`. */
export const PROJECT_PERMISSIONS = [
  {
    id: 'prj-perm-1',
    pattern: 'Bash(pnpm test:*)',
    decision: 'allow',
    groupIds: [],
    source: 'settings',
    isEnabled: true,
  },
  {
    id: 'prj-perm-2',
    pattern: 'Edit(migrations/**)',
    decision: 'deny',
    groupIds: [],
    source: 'settings',
    isEnabled: true,
  },
  {
    id: 'prj-perm-3',
    pattern: 'Bash(git push:*)',
    decision: 'ask',
    groupIds: [],
    source: 'settings',
    isEnabled: true,
  },
];

/**
 * Собственный `.claude` проекта — то, что Claude Code берёт из репозитория
 * поверх пользовательского набора, а панель только показывает.
 */
export const PROJECT_LOCAL = {
  root: `${PROJECT.path}/.claude`,
  exists: true,
  skills: [
    {
      id: 'release-notes',
      name: 'release-notes',
      description: 'Собирает заметки к релизу из закрытых задач витрины.',
      body: '',
      files: ['references/template.md', 'config/sections.json'],
      sizeBytes: 2048,
      modifiedAt: '2026-09-01T10:00:00.000Z',
      groupIds: [],
      isEnabled: true,
    },
    {
      id: 'legacy-import',
      name: 'legacy-import',
      description: 'Разбор старого формата прайса. Выключен до конца переезда.',
      body: '',
      files: [],
      sizeBytes: 512,
      modifiedAt: '2026-08-20T10:00:00.000Z',
      groupIds: [],
      isEnabled: false,
    },
  ],
  hooks: [
    {
      id: 'PreToolUse:shop1',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'node .claude/hooks/guard-destructive.mjs',
      isEnabled: true,
      scriptPath: '.claude/hooks/guard-destructive.mjs',
      scriptExists: true,
      description: 'Страж разрушительных команд.',
      groupIds: [],
      source: 'settings',
    },
    {
      id: 'local:Stop:shop2',
      event: 'Stop',
      command: 'node .claude/hooks/notify-me.mjs',
      isEnabled: true,
      scriptPath: '.claude/hooks/notify-me.mjs',
      scriptExists: false,
      groupIds: [],
      source: 'settings-local',
    },
  ],
  rules: [
    {
      path: 'frontend.md',
      title: 'Витрина: правила фронтенда',
      body: '# Витрина: правила фронтенда\n\nОдин компонент — один файл. Радиус скругления числом, не токеном.',
      paths: ['src/**/*.tsx'],
      sizeBytes: 256,
      modifiedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      path: 'release/commits.md',
      title: 'Формат коммитов',
      body: '# Формат коммитов\n\nЗаголовок — что изменилось и почему, без имён и без процесса.',
      paths: [],
      sizeBytes: 128,
      modifiedAt: '2026-08-15T10:00:00.000Z',
    },
  ],
};

/** Обзор файловой системы для выбора папки: свой, а не диск этой машины. */
export const FS_ROOTS = [
  { name: 'C:\\', path: 'C:/' },
  { name: 'D:\\', path: 'D:/' },
];

export const FS_LISTING = {
  'C:/': {
    path: 'C:/',
    entries: [
      { name: 'work', path: 'C:/work' },
      { name: 'tools', path: 'C:/tools' },
      { name: 'temp', path: 'C:/temp' },
    ],
  },
  'C:/work': {
    path: 'C:/work',
    parent: 'C:/',
    entries: [
      { name: 'shop-front', path: 'C:/work/shop-front' },
      { name: 'shop-admin', path: 'C:/work/shop-admin' },
      { name: 'sandbox', path: 'C:/work/sandbox' },
    ],
  },
};

/** Группа «Ревью фронтенда» — набор, который включают руками. */
export const REVIEW_GROUP_ID = 'grp-review';
/** Группа «Тикеты магазина» — набор с привязкой к проекту и порядком работы. */
export const TICKET_GROUP_ID = 'grp-tickets';

/**
 * Состояние одноразовой панели. Каждый сценарий берёт свежую копию: кадры
 * одного пути не должны зависеть от того, что сделал соседний.
 */
export function makeState() {
  return {
    projects: [PROJECT, PROJECT2],

    groups: [
      {
        id: REVIEW_GROUP_ID,
        name: 'Ревью фронтенда',
        description: 'Всё, что нужно на разборе чужой ветки, и ничего сверх того.',
        color: 'accent',
        icon: 'folder',
        members: [
          { kind: 'rule', id: 'answer-with-diff' },
          { kind: 'skill', id: 'shots-before-after' },
          { kind: 'hook', id: 'PreToolUse:push' },
          { kind: 'mcp', id: 'design-mocks' },
          { kind: 'permission', id: 'perm-push-deny' },
        ],
        env: { REVIEW_STRICT: '1' },
        projectPaths: [],
        isEnabled: true,
        order: 0,
      },
      {
        id: TICKET_GROUP_ID,
        name: 'Тикеты магазина',
        description: 'Порядок работы над тикетом: разбор, правка, проверка.',
        color: 'accent',
        icon: 'folder',
        members: [{ kind: 'skill', id: 'scenario-tikety-magazina' }],
        env: {},
        projectPaths: [PROJECT.path],
        scenario: {
          when: 'Задача пришла тикетом с номером',
          trigger: 'GOR-\\d+',
          compiledSkillId: 'scenario-tikety-magazina',
          steps: [
            {
              title: 'Разобрать тикет',
              body: 'Прочитать описание и найти в коде место, которого он касается.',
              gate: 'Названы файл и строка, с которых начнётся правка',
            },
            {
              title: 'Сделать правку',
              body: 'Минимальную: только то, о чём просит тикет.',
              gate: 'Правка сделана, ничего лишнего рядом не тронуто',
            },
            {
              title: 'Проверить прогоном',
              body: 'Тесты и снимки до/после, если правку видно глазами.',
              gate: 'Прогон зелёный, снимки лежат рядом',
            },
          ],
        },
        isEnabled: true,
        order: 1,
      },
    ],

    automations: [
      {
        id: 'auto-typecheck',
        name: 'Проверка типов после правки',
        description: '',
        trigger: { event: 'PostToolUse', matcher: 'Edit' },
        action: { command: 'pnpm type-check', timeout: 120 },
        isEnabled: true,
        groupIds: [],
        compiledHookId: 'automation:auto-typecheck',
      },
    ],

    rules: [
      entity('answer-with-diff', {
        title: 'Отвечай диффом',
        body: 'Правку показывай куском файла до и после, а не пересказом.',
        order: 0,
        scope: 'global',
      }),
      entity('no-new-deps', {
        title: 'Новых зависимостей не заводить',
        body: 'Пакет добавляется только после отдельного разговора.',
        order: 1,
        scope: 'global',
        // Выключено руками ДО того, как собрали группу: включение группы такое
        // не оживляет, и это ровно тот случай, который человек принимает за
        // поломку. Кадр показывает его настоящим.
        manualOff: true,
      }),
      entity('answer-russian', {
        title: 'Отвечай по-русски',
        body: 'Ответы, вопросы и подписи — по-русски.',
        order: 2,
        scope: 'global',
      }),
    ],

    skills: [
      entity('shots-before-after', {
        name: 'shots-before-after',
        description: 'Снимает экран до и после правки, которую видно глазами.',
        body: '',
        files: ['references/checklist.md'],
        sizeBytes: 3120,
        modifiedAt: '2026-09-02T09:00:00.000Z',
      }),
      entity('scenario-tikety-magazina', {
        name: 'Тикеты магазина',
        description: 'Задача пришла тикетом с номером',
        body: '',
        files: ['trigger.mjs'],
        sizeBytes: 980,
        modifiedAt: '2026-09-10T09:00:00.000Z',
        groupIds: [TICKET_GROUP_ID],
      }),
      entity('release-notes-user', {
        name: 'release-notes',
        description: 'Собирает заметки к релизу.',
        body: '',
        files: [],
        sizeBytes: 740,
        modifiedAt: '2026-08-28T09:00:00.000Z',
      }),
    ],

    hooks: [
      entity('PreToolUse:push', {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: 'node ~/.claude/hooks/no-push.mjs',
        scriptPath: 'hooks/no-push.mjs',
        scriptExists: true,
        source: 'settings',
      }),
      entity('SessionStart:context', {
        event: 'SessionStart',
        command: 'node ~/.claude/hooks/context-budget.mjs',
        scriptPath: 'hooks/context-budget.mjs',
        scriptExists: true,
        source: 'settings',
      }),
      // Триггер группы «Тикеты магазина»: панель собрала его сама из сценария.
      // Отличить собранное от написанного руками можно только по пометке в
      // команде — она же не даёт пересборке задеть чужие хуки.
      entity('scenario:grp-tickets', {
        event: 'UserPromptSubmit',
        command:
          'node "~/.claude/skills/scenario-tikety-magazina/trigger.mjs" ' +
          '# agentdeck:scenario:grp-tickets',
        scriptPath: 'skills/scenario-tikety-magazina/trigger.mjs',
        scriptExists: true,
        source: 'settings',
        groupIds: [TICKET_GROUP_ID],
      }),
    ],

    mcp: [
      entity('design-mocks', {
        name: 'design-mocks',
        transport: 'http',
        url: 'http://127.0.0.1:4010/mcp',
        args: [],
        env: {},
        headers: {},
        health: 'unknown',
        hasOAuth: false,
      }),
      entity('catalog-mock', {
        name: 'catalog-mock',
        transport: 'stdio',
        command: 'node',
        args: ['tools/mcp/catalog.mjs'],
        env: {},
        headers: {},
        health: 'unknown',
        hasOAuth: false,
      }),
    ],

    permissions: [
      entity('perm-push-deny', {
        pattern: 'Bash(git push:*)',
        decision: 'deny',
        source: 'settings',
      }),
      entity('perm-push-allow', {
        pattern: 'Bash(git push:*)',
        decision: 'allow',
        source: 'settings',
      }),
      entity('perm-tests', {
        pattern: 'Bash(pnpm test:*)',
        decision: 'allow',
        source: 'settings',
      }),
    ],
  };
}

/**
 * Сущность с двумя поводами быть выключенной — ровно как их держит панель:
 * ручная отметка и список групп, которые гасят. `isEnabled` считается из них,
 * а не задаётся: иначе кадр «включаю, а оно не включается» пришлось бы
 * рисовать руками.
 */
function entity(id, fields) {
  return { id, groupIds: [], manualOff: false, heldBy: [], ...fields };
}

/** Вид, в котором сущность уходит клиенту: служебные поля наружу не торчат. */
function view(item) {
  const { manualOff, heldBy, ...rest } = item;
  return { ...rest, isEnabled: !manualOff && heldBy.length === 0 };
}

const KIND_TO_LIST = {
  rule: 'rules',
  skill: 'skills',
  hook: 'hooks',
  mcp: 'mcp',
  permission: 'permissions',
};

/** Развернуть состав группы до листьев: участником может быть другая группа. */
function leaves(state, members, seen = new Set()) {
  const out = [];
  for (const member of members) {
    if (member.kind !== 'group') {
      out.push(member);
      continue;
    }
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    const nested = state.groups.find((group) => group.id === member.id);
    if (nested) out.push(...leaves(state, nested.members, seen));
  }
  return out;
}

/**
 * Переключить группу так же, как это делает сервер: отметка «погашено этой
 * группой» ставится отдельно от ручной, поэтому выключенный руками участник
 * при включении группы не оживает, а участник двух групп ждёт обеих.
 */
export function toggleGroup(state, groupId, isEnabled) {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) return { ok: true, affected: 0 };
  group.isEnabled = isEnabled;

  let affected = 0;
  for (const member of leaves(state, group.members)) {
    const list = state[KIND_TO_LIST[member.kind]] ?? [];
    const item = list.find((entry) => entry.id === member.id);
    if (!item) continue;
    item.heldBy = isEnabled
      ? item.heldBy.filter((holder) => holder !== groupId)
      : [...new Set([...item.heldBy, groupId])];
    item.groupIds = [...new Set([...item.groupIds, groupId])];
    affected += 1;
  }
  return { ok: true, affected };
}

/** Сводка для боковой панели: те же списки, только пересчитанные. */
function overview(state) {
  const on = (list) => list.filter((item) => view(item).isEnabled).length;
  const decision = (value) =>
    state.permissions.filter((item) => item.decision === value && view(item).isEnabled).length;

  return {
    rules: { total: state.rules.length, enabled: on(state.rules) },
    hooks: {
      total: state.hooks.length,
      enabled: on(state.hooks),
      broken: state.hooks.filter((item) => item.scriptExists === false).length,
    },
    skills: { total: state.skills.length, enabled: on(state.skills) },
    scripts: { total: 0, unused: 0 },
    mcp: { total: state.mcp.length, enabled: on(state.mcp), connected: 0, failed: 0 },
    permissions: { allow: decision('allow'), ask: decision('ask'), deny: decision('deny') },
    groups: { total: state.groups.length },
  };
}

/** Ответ JSON, но с памятью: обработчик читает состояние на КАЖДЫЙ запрос. */
const json = (page, pattern, produce) =>
  page.route(pattern, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ json: produce() });
  });

/**
 * Мастер онбординга и провайдер одним перехватом настроек: двумя маршрутами
 * нельзя — Playwright отдаёт запрос последнему подходящему обработчику, и
 * вторая подмена настроек отменила бы обход мастера.
 */
export async function settings(page, patch = {}) {
  await page.route('**/api/settings', async (route) => {
    try {
      if (route.request().method() !== 'GET') return await route.continue();
      const response = await route.fetch();
      const body = await response.json();
      return await route.fulfill({
        response,
        json: { ...body, provider: 'claude', ...patch, onboardingDone: true },
      });
    } catch {
      /* контекст закрыт — отвечать уже некому */
    }
  });
}

/**
 * Всё, что спрашивают страницы «Проекты» и «Группы». Порядок маршрутов значим:
 * Playwright берёт ПОСЛЕДНИЙ подходящий, поэтому частное (`/projects/local`)
 * регистрируется после общего (`/projects`).
 */
export async function panelShell(page, state) {
  // Счётчики боковой панели считает сервер отдельным запросом. Без него у
  // разделов стояли бы нули рядом со списком из трёх правил — мелкая, но
  // настоящая ложь в кадре.
  await json(page, '**/api/overview*', () => overview(state));

  await json(page, '**/api/rules*', () => state.rules.map(view));
  await json(page, '**/api/skills*', () => state.skills.map(view));
  await json(page, '**/api/hooks*', () => state.hooks.map(view));
  await json(page, '**/api/mcp*', () => state.mcp.map(view));
  await json(page, '**/api/permissions*', () => state.permissions.map(view));

  // Группа и сценарий-автоматизация создаются ПРЯМО В КАДРЕ: человек нажимает
  // «Сохранить» и видит карточку, которой секунду назад не было. Ответ готовым
  // списком показал бы экран, до которого он не доходил.
  await page.route('**/api/groups', (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fulfill({ json: state.groups });
    const draft = request.postDataJSON() ?? {};
    const group = {
      id: `grp-${state.groups.length + 1}`,
      order: state.groups.length,
      isEnabled: true,
      ...draft,
    };
    state.groups.push(group);
    return route.fulfill({ json: group });
  });

  await page.route('**/api/automations', (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fulfill({ json: state.automations });
    const draft = request.postDataJSON() ?? {};
    const automation = { id: `auto-${state.automations.length + 1}`, isEnabled: true, ...draft };
    state.automations.push(automation);
    // Сохранение пересобирает хуки: скомпилированная запись появляется в
    // settings.json с пометкой в команде — по ней её и отличают от ручной.
    state.hooks.push({
      id: `automation:${automation.id}`,
      event: automation.trigger.event,
      matcher: automation.trigger.matcher,
      command: `${automation.action.command} # agentdeck:automation:${automation.id}`,
      timeout: automation.action.timeout,
      scriptExists: true,
      source: 'settings',
      groupIds: [],
      manualOff: false,
      heldBy: [],
    });
    return route.fulfill({ json: automation });
  });

  // Реестр проектов: POST добавляет запись, как это делает сервер, — пустой
  // раздел и раздел с проектом в одном сценарии иначе не снять.
  await page.route('**/api/projects', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const draft = request.postDataJSON() ?? {};
      const path = draft.path ?? '';
      // Уже зарегистрированный путь сервер отдаёт прежней записью, не заводя
      // вторую; известные заранее проекты сохраняют свои идентификаторы —
      // по ним сценарий потом открывает конфиг ссылкой.
      const known =
        state.projects.find((item) => item.path === path) ??
        [PROJECT, PROJECT2].find((item) => item.path === path);
      const added = known ?? {
        id: `prj-${state.projects.length + 1}`,
        name: draft.name ?? 'Проект',
        path,
      };
      if (!state.projects.includes(added)) state.projects.push(added);
      return route.fulfill({ json: added });
    }
    if (request.method() === 'DELETE') return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: state.projects });
  });

  await page.route('**/api/projects/*/rules', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { content: PROJECT_RULES } })
      : route.fulfill({ json: { ok: true } }),
  );
  await json(page, '**/api/projects/*/mcp*', () => PROJECT_MCP);
  await json(page, '**/api/projects/*/permissions*', () => PROJECT_PERMISSIONS);
  await json(page, '**/api/projects/*/local*', () => PROJECT_LOCAL);
  await json(page, '**/api/projects/local?*', () => PROJECT_LOCAL);

  await json(page, '**/api/fs/roots*', () => FS_ROOTS);
  await page.route('**/api/fs/list*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    return route.fulfill({ json: FS_LISTING[path] ?? { path, entries: [] } });
  });

  // Связи с трекером на карточке проекта: интеграции в одноразовой панели не
  // настроены, и без ответа полоса висела бы неопределённой.
  await json(page, '**/api/integrations/links*', () => ({ links: [] }));
  await json(page, '**/api/integrations', () => []);

  await page.route('**/api/groups/*/enabled', (route) => {
    const id = route.request().url().split('/groups/')[1].split('/')[0];
    const body = route.request().postDataJSON() ?? {};
    return route.fulfill({ json: toggleGroup(state, id, body.isEnabled === true) });
  });
}

/** Открыть страницу панели и дождаться, пока она перестанет мигать скелетами. */
export async function open(page, web, path) {
  await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1500);
}
