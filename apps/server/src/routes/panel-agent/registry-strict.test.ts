import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANEL_ACTIONS } from './actions.ts';
import { PANEL_SECTIONS } from './sections/sections.ts';

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
  // Страницы ядра: агенту — только открыть их; команды задаче ядра — рукой человека
  // (`POST /api/core/commands` — `human:rights`), своих действий у агента там нет.
  '/core': ['navigation'],
  '/core/launch': ['navigation'],
  '/core/scenarios': ['navigation'],
  '/core/chat': ['navigation'],
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
});
