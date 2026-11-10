import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORE_PANEL_ROUTES, PANEL_CORE_PREFIX } from '@agentdeck/contracts/core/panel-api';
import { PANEL_ACTIONS } from './actions.ts';
import { PANEL_SECTIONS } from './sections/sections.ts';
import { ROUTE_LEDGER, resolveRouteKey } from './capability-ledger/capability-ledger.ts';
import type { InjectRoute } from './registry.ts';

/**
 * Строгая сверка реестра действий агента в обе стороны:
 * - каждое действие с записью (change/danger) показывает карточку И снимает
 *   отпечаток — без отпечатка правка между показом и кликом прошла бы молча;
 * - у каждого раздела панели есть хотя бы одно действие, и каждое действие
 *   принадлежит разделу панели (или навигации);
 * - каждое действие хоть раз вызывается интеграционным тестом через маршрут.
 */

/** Раздел окна → разделы действий. Настройки собирают несколько разделов действий. */
const ROUTE_SECTIONS: Record<string, readonly string[]> = {
  '/': ['overview'],
  '/search': ['search'],
  '/groups': ['groups'],
  '/history': ['history'],
  '/settings': ['settings', 'provider', 'endpoints', 'integrations'],
  '/dlp': ['dlp'],
  '/local-models': ['local-models'],
  '/kit': ['kit'],
  '/platform': ['contour'],
  '/compare': ['compare'],
  '/portability': ['portability'],
  '/help': ['help'],
  '/analytics': ['analytics'],
  '/chat': ['chat'],
  '/rules': ['rules'],
  '/claude-md': ['claude-md'],
  '/hooks': ['hooks'],
  '/skills': ['skills'],
  '/commands': ['commands'],
  '/scripts': ['scripts'],
  '/plugins': ['plugins'],
  '/mcp': ['mcp'],
  '/permissions': ['permissions'],
  '/env': ['env'],
  '/projects': ['projects'],
  '/tests': ['tests'],
  // Страницы ядра: задачи, их ленту, отчёт и настройки ведущего агент читает (этап 11, P151);
  // команды задаче, оценка, настройка и сценарии — рукой человека (`human:rights`).
  '/core': ['core'],
  '/core/launch': ['navigation'],
  '/core/scenarios': ['navigation'],
};

/** Снятые действия: запись групп, разделение задач, общие правила разделения (этап 10, F3). */
const RETIRED_ACTIONS = [
  'read_group',
  'draft_group',
  'add_group_step',
  'move_group_step',
  'set_group_knobs',
  'draft_scenario',
  'copy_group',
  'list_discovered_groups',
  'run_group_discovery',
  'import_discovered_group',
  'copy_group_to_global',
  'apply_group_advice',
  'merge_group_origin',
  'read_group_override',
  'set_group_override',
  'activate_groups_for_path',
  'list_resource_catalog',
  'draft_group_step',
  'promote_group_step',
  'save_group',
  'toggle_group',
  'delete_group',
  'request_split',
  'split_decline',
  'set_chat_group',
  'read_split_overlap',
  'split_accept_group',
  'split_resume_interrupted',
  'summarize_resource',
  'read_project_group_choice',
  'set_project_group_choice',
  'read_split_defaults',
  'save_split_defaults',
];

/** Разделы действий без своей страницы. */
const PAGELESS = ['navigation'];

// ---- ручки ядра (P151): каждая строка — действие, человек, названный пробел или служебная ----

/** Чтения ядра — действия агента (через прокладку панели: токен ядра остаётся у сервера). */
const CORE_READS: Readonly<Record<string, string>> = {
  'GET /api/core/tasks': 'action:core_tasks',
  'GET /api/core/tasks/:id': 'action:core_task',
  'GET /api/core/tasks/:id/report': 'action:core_report',
  'GET /api/core/config': 'action:core_lead_settings',
  // Агенты ядра (W3-19): разговор, дерево задачи, узел подробно — одно действие.
  'GET /api/core/agents': 'action:core_agents',
  'GET /api/core/tasks/:id/agents': 'action:core_agents',
  'GET /api/core/tasks/:id/agents/:nodeId': 'action:core_agents',
};

/**
 * Запись в ядро — только человек. Оценка СОЗДАЁТ задачу (`authority.ts` `estimate: 'human'`):
 * до этапа 11 она стояла `internal:preview` («ничего не пишет»), и любое действие могло позвать
 * её при сборке карточки.
 */
const CORE_HUMAN: Readonly<Record<string, string>> = {
  'POST /api/core/commands': 'human:rights',
  'POST /api/core/estimate': 'human:rights',
  'POST /api/core/config': 'human:rights',
  'POST /api/core/scenarios': 'human:rights',
  'POST /api/core/devices/adopt': 'human:rights',
  'POST /api/core/review-link': 'human:rights',
  // Сброс ключа обучения ведущего (P140) и выгрузка журнала агентов (W3-19) — человеку.
  'POST /api/core/learned/reset': 'human:rights',
  'GET /api/core/tasks/:id/agents/export': 'human:download',
  'POST /api/core/supervisor/restart': 'human:consent',
  'POST /api/core/supervisor/autostart': 'human:consent',
  // Ход на доске задач (этап 12) — очередь и запуск, человеку.
  'POST /api/core/board/move': 'human:rights',
  'POST /api/core/board/entries': 'human:rights',
  // Записи во «Входящие» (этап 12, P167) — человеку.
  'POST /api/core/inbox': 'human:rights',
};

/** Чтения ядра, которых ведущему пока не нужно, — каждая названа (лента P3). */
const CORE_GAPS: readonly string[] = [
  'GET /api/core/routes',
  'GET /api/core/scenarios',
  'GET /api/core/scenarios/:ref',
  'GET /api/core/records/:id',
  'GET /api/core/profiles/:repoKey',
  'GET /api/core/mcp-offers',
  // Распределитель и активность локальных моделей (этап 11, зона C).
  'GET /api/core/allocator',
  'GET /api/core/local/activity',
  // Доска задач (этап 12): ведущему пока не нужна.
  'GET /api/core/board',
  // Поиск во входящих (этап 12): ведущему пока не нужен.
  'GET /api/core/inbox/search',
  // Проход по стенду задачи (этап 12, P177): ведущему пока не нужен.
  'GET /api/core/tasks/:id/walk',
];

/** Служебные строки ядра: окно, потоки, обратный вызов — не возможность агента. */
const CORE_INTERNAL: Readonly<Record<string, string>> = {
  'GET /api/core/nonce': 'internal:ui-state',
  'GET /api/core/health': 'internal:ui-state',
  'GET /api/core/supervisor': 'internal:ui-state',
  'GET /api/core/tasks/:id/events': 'internal:stream',
  'GET /api/core/tasks/:id/sessions/:sid/stream': 'internal:stream',
  // Потоки дерева агентов и активности локальных моделей — для окна; агент читает снимки.
  'GET /api/core/tasks/:id/agents/stream': 'internal:stream',
  'GET /api/core/local/activity/stream': 'internal:stream',
  'GET /api/core/delivery': 'internal:callback',
  // Только перевод «пути» группы в сценарий, ничего не пишет (этап 10, F1).
  'POST /api/core/scenarios/from-path': 'internal:preview',
};

/** Ручки под `/api/core`, которые держит сама панель, а не список контрактов ядра. */
const PANEL_OWN_CORE_ROWS = [
  'GET /api/core/supervisor',
  'POST /api/core/supervisor/restart',
  'POST /api/core/supervisor/autostart',
];

const TASK_ID = '01900000-0000-7000-8000-000000000001';

/**
 * Входы каждого действия раздела `core` для проверки его запроса без панели — по входу на каждую
 * ветку запроса: у `core_agents` их три (разговор, дерево задачи, узел подробно).
 */
const CORE_ACTION_INPUTS: Readonly<Record<string, readonly unknown[]>> = {
  core_tasks: [{}],
  core_task: [{ taskId: TASK_ID }],
  core_report: [{ taskId: TASK_ID }],
  core_lead_settings: [{}],
  core_agents: [
    { conversationId: 'conv-1' },
    { conversationId: 'conv-1', status: 'running' },
    { taskId: TASK_ID },
    { taskId: TASK_ID, nodeId: 'toolu_01SubAgent' },
  ],
};

const isCoreRow = (key: string): boolean => /^[A-Z]+ \/api\/core(\/|$)/.test(key);

function coreLedgerRows(ledger: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(ledger).filter(([key]) => isCoreRow(key)));
}

const expectedCoreRows = (): Record<string, string> => ({
  ...CORE_READS,
  ...CORE_HUMAN,
  ...CORE_INTERNAL,
  ...Object.fromEntries(CORE_GAPS.map((key) => [key, 'gap:P3'])),
});

describe('реестр действий агента: строгая сверка', () => {
  it('имена уникальны', () => {
    const names = PANEL_ACTIONS.map((action) => action.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('каждое действие с записью — с карточкой, отпечатком и заголовком следа', () => {
    const problems = PANEL_ACTIONS.filter((action) => action.risk !== 'read').flatMap((action) => [
      ...(action.preview ? [] : [`${action.name}: нет preview`]),
      ...(action.fingerprint ? [] : [`${action.name}: нет fingerprint`]),
      ...(action.title ? [] : [`${action.name}: нет title`]),
      ...(action.route || action.local ? [] : [`${action.name}: нечем исполнить`]),
    ]);
    expect(problems).toEqual([]);
  });

  it('каждое чтение — со сводкой следа и без карточки', () => {
    const problems = PANEL_ACTIONS.filter((action) => action.risk === 'read').flatMap((action) => [
      ...(action.summary || action.local ? [] : [`${action.name}: нет summary`]),
      ...(action.preview ? [`${action.name}: чтение с карточкой`] : []),
    ]);
    expect(problems).toEqual([]);
  });

  it('разделы окна ↔ разделы действий — в обе стороны', () => {
    // Карта сверки покрывает ровно разделы окна.
    expect(Object.keys(ROUTE_SECTIONS).sort()).toEqual(
      PANEL_SECTIONS.map((section) => section.route).sort(),
    );
    const actionSections = new Set(PANEL_ACTIONS.map((action) => action.section));
    const withoutActions = Object.entries(ROUTE_SECTIONS).flatMap(([route, keys]) =>
      keys.filter((key) => !actionSections.has(key)).map((key) => `${route} → ${key}`),
    );
    expect(withoutActions).toEqual([]);
    const allowed = new Set([...Object.values(ROUTE_SECTIONS).flat(), ...PAGELESS]);
    const orphan = [...actionSections].filter((section) => !allowed.has(section));
    expect(orphan).toEqual([]);
  });

  it('действий записи групп, разделения и общих правил разделения нет (группы — только чтение)', () => {
    // Этап 10, F3: группы ведёт ядро, у агента от групп остался только `list_groups`.
    const names = new Set(PANEL_ACTIONS.map((action) => action.name));
    expect(RETIRED_ACTIONS.filter((name) => names.has(name))).toEqual([]);
    expect(names.has('list_groups')).toBe(true);
    const tree = PANEL_ACTIONS.find((action) => action.name === 'split_control');
    const modeOk = (mode: string): boolean =>
      Boolean(tree?.input.safeParse({ chat: 'c1', mode }).success);
    expect(['pause_all', 'resume_all'].filter(modeOk)).toEqual(['pause_all', 'resume_all']);
    const groupModes = ['pause_group', 'resume_group', 'release_group'];
    expect(groupModes.filter(modeOk)).toEqual([]);
  });

  /**
   * `continue_group` назван, но не исполняется (решение 02.11 в `actions-chat-control.ts`):
   * продолжить сдавшуюся задачу ядра может только ответ человека, и агент получает
   * названный отказ до карточки, а не тихое «нет такого режима». Записью в группы
   * режим так и не стал: маршрут не строится.
   */
  it('continue_group — названный отказ до карточки, без запроса к панели', async () => {
    const tree = PANEL_ACTIONS.find((action) => action.name === 'split_control');
    const input = { chat: 'c1', mode: 'continue_group' };
    expect(tree?.input.safeParse(input).success).toBe(true);
    const inject = (): never => {
      throw new Error('no request may be made for continue_group');
    };
    const route = tree?.route as (input: unknown, inject: unknown) => Promise<unknown>;
    await expect(route(input, inject)).rejects.toThrow(/^core-continue-human-only/);
  });

  it('каждое действие вызывается интеграционным тестом через маршрут', () => {
    const dir = import.meta.dirname;
    const tests = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.integration.test.ts'))
      .map((file) => readFileSync(resolve(dir, file), 'utf8'))
      .join('\n');
    const untested = PANEL_ACTIONS.map((action) => action.name).filter(
      // Вызов действия тестом или настоящий инструмент MCP в потоке фальшивого CLI.
      (name) => !new RegExp(`(call|decided)\\(\\s*'${name}'|__${name}'`).test(tests),
    );
    expect(untested).toEqual([]);
  });

  describe('ручки ядра (P151)', () => {
    it('каждая строка /api/core — действие, строка человека, названный gap:P3 или служебная', () => {
      // В обе стороны: новая ручка без своего места здесь и снятая ручка — красное.
      expect(coreLedgerRows(ROUTE_LEDGER)).toEqual(expectedCoreRows());
    });

    it('каждая ручка списка контрактов ядра — строка реестра, и каждая строка — ручка', () => {
      const contract = CORE_PANEL_ROUTES.map(
        (route) => `${route.method} ${PANEL_CORE_PREFIX}${route.path}`,
      );
      const rows = Object.keys(coreLedgerRows(ROUTE_LEDGER));
      expect(contract.filter((key) => !rows.includes(key))).toEqual([]);
      expect(
        rows.filter((key) => !contract.includes(key) && !PANEL_OWN_CORE_ROWS.includes(key)),
      ).toEqual([]);
    });

    it('запись в ядро агенту закрыта: каждая POST-строка — человек (кроме перевода пути)', () => {
      const open = Object.entries(coreLedgerRows(ROUTE_LEDGER)).filter(
        ([key, routeClass]) =>
          key.startsWith('POST ') &&
          !routeClass.startsWith('human:') &&
          !(key in CORE_INTERNAL && routeClass === 'internal:preview'),
      );
      expect(open).toEqual([]);
      for (const key of [
        'POST /api/core/estimate',
        'POST /api/core/config',
        'POST /api/core/scenarios',
        'POST /api/core/learned/reset',
      ]) {
        expect(ROUTE_LEDGER[key], key).toBe('human:rights');
      }
    });

    it('действия раздела core — только чтения GET по своей строке реестра', async () => {
      const core = PANEL_ACTIONS.filter((action) => action.section === 'core');
      expect(core.map((action) => action.name).sort()).toEqual(
        Object.keys(CORE_ACTION_INPUTS).sort(),
      );
      const inject: InjectRoute = () => {
        throw new Error('a core read builds its request without the panel');
      };
      const problems: string[] = [];
      const reached = new Set<string>();
      for (const action of core) {
        if (action.risk !== 'read') problems.push(`${action.name}: risk ${action.risk}`);
        for (const raw of CORE_ACTION_INPUTS[action.name] ?? []) {
          const request = await action.route!(action.input.parse(raw), inject);
          const key = resolveRouteKey(ROUTE_LEDGER, request.method, request.url);
          if (request.method !== 'GET') problems.push(`${action.name}: ${request.method}`);
          if (key) reached.add(key);
          if (!key || ROUTE_LEDGER[key] !== `action:${action.name}`)
            problems.push(`${action.name}: ${request.method} ${request.url} → ${key ?? 'no row'}`);
        }
      }
      expect(problems).toEqual([]);
      // Обратно: каждая строка чтения ядра достигнута своим действием, а не только выдана.
      expect(Object.keys(CORE_READS).filter((key) => !reached.has(key))).toEqual([]);
    });

    it('core_agents: без разговора и задачи, и узел без задачи — отказ входа до запроса', () => {
      const agents = PANEL_ACTIONS.find((action) => action.name === 'core_agents')!;
      for (const bad of [
        {},
        { conversationId: 'conv-1', taskId: TASK_ID },
        { conversationId: 'conv-1', nodeId: 'toolu_01SubAgent' },
      ]) {
        expect(agents.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });

    it('ни одно действие агента не шлёт запись в ядро', async () => {
      // Действия с маршрутом, собранным без панели и без входа, — их запрос виден сразу.
      const writes: string[] = [];
      for (const action of PANEL_ACTIONS) {
        if (!action.route) continue;
        for (const raw of CORE_ACTION_INPUTS[action.name] ?? [{}]) {
          const parsed = action.input.safeParse(raw);
          if (!parsed.success) continue;
          let request: { method: string; url: string } | undefined;
          try {
            request = await action.route(parsed.data, () => {
              throw new Error('no panel here');
            });
          } catch {
            continue;
          }
          if (request.method !== 'GET' && isCoreRow(`${request.method} ${request.url}`))
            writes.push(`${action.name}: ${request.method} ${request.url}`);
        }
      }
      expect(writes).toEqual([]);
    });
  });
});
