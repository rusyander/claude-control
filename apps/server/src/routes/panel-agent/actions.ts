import { resolve } from 'node:path';
import { z } from 'zod';
import { projectName } from '../../domains/projects.ts';
import { definePanelAction, fingerprintOf, type AnyPanelAction } from './registry.ts';
import { readRoute } from './action-kit.ts';
import { PANEL_SECTIONS, sectionRoutes } from './sections.ts';
import { PROJECT_CHAT_ACTIONS } from './actions-projects.ts';
import { TEST_ACTIONS } from './actions-tests.ts';
import { CONTOUR_ACTIONS } from './actions-contour.ts';
import { CONFIG_ACTIONS } from './actions-config.ts';
import { HOOKS_ENV_ACTIONS } from './actions-hooks-env.ts';
import { APP_STATE_ACTIONS } from './actions-app.ts';
import { PANEL_READ_ACTIONS } from './actions-panel.ts';
import { WORK_ACTIONS } from './actions-work.ts';
import { dataField, summaryText } from './texts.ts';

/**
 * Стартовый набор действий (А1): ровно столько, чтобы машина реестра была
 * доказана от конца до конца — чтение без вопроса, навигация кадром в поток,
 * чтение через маршрут и изменение через карточку. Разделы целиком — А4+.
 */

const whereAmI = definePanelAction({
  name: 'where_am_i',
  section: 'navigation',
  risk: 'read',
  description:
    'Where the human is in the panel right now: route, page title, selected project (as of this turn).',
  input: z.object({}),
  // Ответ из контекста хода, а не догадка по потоку событий: окно присылает
  // страницу с каждым сообщением, и именно её видел человек, когда писал.
  local: (_input, env) => {
    const context = env.pageContext();
    if (!context)
      return { known: false, note: 'No page context: this call is outside an agent turn.' };
    const section = PANEL_SECTIONS.find((item) => item.route === context.route);
    return { known: true, ...context, ...(section ? { section: section.title } : {}) };
  },
  summary: 'journal-where-am-i',
});

const listSections = definePanelAction({
  name: 'list_sections',
  section: 'navigation',
  risk: 'read',
  description: 'List the panel sections (route, title, what it is for). Use before open_page.',
  input: z.object({}),
  local: () => ({ sections: PANEL_SECTIONS }),
  summary: 'journal-list-sections',
});

const openPage = definePanelAction({
  name: 'open_page',
  section: 'navigation',
  risk: 'read',
  description:
    'Open a panel section on the human’s screen. Does not change any data. ' +
    'Result `windows` = how many panel windows received it (0 = nobody sees it).',
  input: z.object({
    route: z.enum(sectionRoutes()).describe('Section route from list_sections'),
    focus: z.string().max(200).optional().describe('Optional element id or section key'),
  }),
  // Окно получает кадр из `page` — один путь для навигации и для «показать
  // результат»; здесь только честный ответ, увидел ли его кто-нибудь.
  local: (input, env) => ({ opened: input.route, windows: env.windows() }),
  summary: 'journal-open-page',
  page: (input) => ({ route: input.route, ...(input.focus ? { focus: input.focus } : {}) }),
});

const listProjects = definePanelAction({
  name: 'list_projects',
  section: 'projects',
  risk: 'read',
  description: 'List projects registered in the panel (id, name, absolute path).',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/projects' }),
  summary: 'journal-list-projects',
});

const createProject = definePanelAction({
  name: 'create_project',
  section: 'projects',
  risk: 'change',
  title: 'journal-create-project',
  description:
    'Register an existing directory as a panel project. Needs the human’s confirmation. ' +
    'The directory must already exist; nothing is created on disk.',
  input: z.object({
    path: z.string().trim().min(1).describe('Absolute path to an existing project directory'),
    name: z.string().trim().min(1).max(200).optional().describe('Display name; default = dir name'),
    open: z
      .enum(['projects', 'chat'])
      .optional()
      .describe('What to open afterwards: the project card (default) or its chat'),
  }),
  route: (input) => ({
    method: 'POST',
    url: '/api/projects',
    body: { path: input.path, ...(input.name ? { name: input.name } : {}) },
  }),
  // Отпечаток — занят ли каталог в реестре: заведённый руками между карточкой и
  // кликом проект называется устаревшей карточкой, а не отказом маршрута.
  fingerprint: async (input, inject) => {
    const path = resolve(input.path);
    const projects = await readRoute<Array<{ path: string }>>(inject, '/api/projects');
    return fingerprintOf(projects.some((project) => resolve(project.path) === path));
  },
  // Путь и имя — те, что запишет маршрут (`makeProject`), а не сырой ввод модели:
  // человек подтверждает то, что окажется в реестре.
  preview: (input) => {
    const path = resolve(input.path);
    const title = input.name ?? projectName(path);
    return {
      ...summaryText('summary-create-project', { title }),
      fields: [dataField('label-directory', path), dataField('label-title', title)],
    };
  },
  // Открывается сам созданный проект, а не общий список: человек видит то,
  // что подтвердил. Просьба «и открой чат» — вкладка чата этого проекта.
  page: (input, result) => {
    const id = (result as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string') return { route: '/projects' };
    return input.open === 'chat'
      ? { route: '/chat', focus: `project:${id}` }
      : { route: `/projects?id=${encodeURIComponent(id)}` };
  },
});

/** Реестр действий панели в порядке показа. */
export const PANEL_ACTIONS: readonly AnyPanelAction[] = [
  whereAmI,
  listSections,
  openPage,
  listProjects,
  createProject,
  ...PROJECT_CHAT_ACTIONS,
  ...TEST_ACTIONS,
  ...CONTOUR_ACTIONS,
  ...CONFIG_ACTIONS,
  ...HOOKS_ENV_ACTIONS,
  ...APP_STATE_ACTIONS,
  ...WORK_ACTIONS,
  ...PANEL_READ_ACTIONS,
];
