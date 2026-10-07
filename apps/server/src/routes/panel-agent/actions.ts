import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { projectDirProblem, projectName, type ProjectDirProblem } from '../../domains/projects.ts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import { spelledOnDisk } from '../../lib/disk-spelling.ts';
import { definePanelAction, fingerprintOf, type AnyPanelAction } from './registry.ts';
import { readRoute } from './action-kit.ts';
import { PANEL_SECTIONS, sectionRoutes } from './sections.ts';
import { testsPage } from './tests-page.ts';
import { PROJECT_CHAT_ACTIONS } from './actions-projects.ts';
import { TEST_ACTIONS } from './actions-tests.ts';
import { CONTOUR_ACTIONS } from './actions-contour.ts';
import { CONFIG_ACTIONS } from './actions-config.ts';
import { HOOKS_ENV_ACTIONS } from './actions-hooks-env.ts';
import { APP_STATE_ACTIONS } from './actions-app.ts';
import { PANEL_READ_ACTIONS } from './actions-panel.ts';
import { WORK_ACTIONS } from './actions-work.ts';
import { GROUP_ACTIONS } from './actions-groups.ts';
import { TESTS_BLOCK_ACTIONS } from './actions-tests-block.ts';
import { GROUP_SOURCES_ACTIONS } from './actions-groups-sources.ts';
import { ENTITY_EXTRA_ACTIONS } from './actions-entities-extra.ts';
import { SETTINGS_EXTRA_ACTIONS } from './actions-settings-extra.ts';
import { SIEVE_ACTIONS } from './actions-sieves.ts';
import { DLP_EXTRA_ACTIONS } from './actions-dlp-extra.ts';
import { CONTOUR_MANAGE_ACTIONS } from './actions-contour-manage.ts';
import { INTEGRATIONS_READ_ACTIONS } from './actions-integrations-read.ts';
import { PORTABILITY_ACTIONS } from './actions-portability.ts';
import { MISC_EXTRA_ACTIONS } from './actions-misc-extra.ts';
import { CHAT_EXTRA_ACTIONS } from './actions-chat-extra.ts';
import { SANDBOX_ACTIONS } from './actions-sandbox.ts';
import { CONTOUR_AGENT_ACTIONS } from './actions-contour-agents.ts';
import { CHAT_ACTIONS } from './actions-chat.ts';
import { PROJECT_CONFIG_ACTIONS } from './actions-project-config.ts';
import { PROJECT_GIT_ACTIONS } from './actions-project-git.ts';
import { PROJECT_RUNNER_ACTIONS } from './actions-project-runner.ts';
import { GAPS_CHAT_ACTIONS } from './actions-gaps-chat.ts';
import { GAPS_SETTINGS_ACTIONS } from './actions-gaps-settings.ts';
import { GAPS_PROJECT_ACTIONS } from './actions-gaps-projects.ts';
import { GAPS_TESTS_ACTIONS } from './actions-gaps-tests.ts';
import { LOCAL_MODELS_ACTIONS } from './actions-local-models.ts';
import { KIT_ACTIONS } from './actions-kit.ts';
import { dataField, summaryText, textField } from './texts.ts';
import { PANEL_E2E_DIR } from '../../domains/project-tests/e2e-scaffold.ts';
import type { ProjectTestE2eFolder } from '@agentdeck/contracts';
import type { PanelActionPreviewField } from '@agentdeck/contracts/panel-agent';
import type { InjectRoute } from './registry.ts';

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
  input: z
    .object({
      route: z.enum(sectionRoutes()).describe('Section route from list_sections'),
      focus: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Optional, by route: /settings and /tests — a tab key from list_sections `tabs`; /chat — a chat id; ' +
            '/projects — a project id; any other section — an element id',
        ),
      projectPath: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Only with /tests: absolute project path from list_projects — opens the section on THAT ' +
            'project (the section otherwise shows whichever project the browser last picked)',
        ),
    })
    // Раздел тестов помнит выбранный проект в браузере: «открой тестирование
    // проекта X» без проекта в адресе показывало бы тесты другого проекта.
    // У прочих разделов проекта в адресе нет — там поле было бы молча проглочено.
    .refine((input) => input.projectPath === undefined || input.route === '/tests', {
      message: 'projectPath is accepted only with route /tests',
      path: ['projectPath'],
    })
    .refine((input) => input.projectPath === undefined || isAbsolute(input.projectPath), {
      message: 'projectPath must be an absolute directory (take it from list_projects)',
      path: ['projectPath'],
    }),
  // Окно получает кадр из `page` — один путь для навигации и для «показать
  // результат»; здесь только честный ответ, увидел ли его кто-нибудь.
  local: (input, env) => ({ opened: input.route, windows: env.windows() }),
  summary: 'journal-open-page',
  page: (input) =>
    input.projectPath
      ? { ...testsPage(input.projectPath), ...(input.focus ? { focus: input.focus } : {}) }
      : { route: input.route, ...(input.focus ? { focus: input.focus } : {}) },
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

const PROJECT_DIR_PROBLEM_EN: Record<ProjectDirProblem, string> = {
  empty: 'The project path is empty',
  relative: 'The project path must be absolute',
  missing: 'The project directory does not exist',
  'not-dir': 'The project path is not a directory',
  unreadable: 'The project directory cannot be read',
};

const createProject = definePanelAction({
  name: 'create_project',
  section: 'projects',
  risk: 'change',
  title: 'journal-create-project',
  description:
    'Register an existing directory as a panel project. Needs the human’s confirmation. ' +
    'The directory must already exist. The panel also sets up the project’s e2e folder: an ' +
    'existing own folder has its tests synced into cases under .agent/tests; without one the ' +
    'panel creates an e2e/ Playwright starter, hidden from git via .git/info/exclude. The ' +
    'result’s `e2e` field says which happened — tell the human.',
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
  // Сравнение — как у реестра (`findProjectByPath`): на Windows без регистра,
  // иначе `C:/Work` против `c:/work` проходил мимо и кончался отказом 409.
  fingerprint: async (input, inject) => {
    // Написание — как у `makeProject` (на диске): короткое имя 8.3 и длинное —
    // один каталог, и сравнение по вводу модели проходило мимо записанного.
    const path = normalizeProjectPath(spelledOnDisk(resolve(input.path)));
    const projects = await readRoute<Array<{ path: string }>>(inject, '/api/projects');
    return fingerprintOf(
      // Записи реестра — тоже написанием на диске: старые хранят 8.3 или регистр ввода.
      projects.some(
        (project) => normalizeProjectPath(spelledOnDisk(resolve(project.path))) === path,
      ),
    );
  },
  // Путь и имя — те, что запишет маршрут (`makeProject`), а не сырой ввод модели:
  // человек подтверждает то, что окажется в реестре.
  // Ввод, который маршрут всё равно отвергнет, отказан ДО карточки: иначе человек
  // одобрял бы ничто, а относительный путь показывался бы от каталога сервера.
  preview: async (input, inject) => {
    // Агенту — по-английски: русский текст `checkProjectDir` предназначен человеку.
    const problem = projectDirProblem(input.path);
    if (problem) {
      throw new Error(
        `${PROJECT_DIR_PROBLEM_EN[problem]}: «${input.path}». Ask the human for the absolute path of an existing directory.`,
      );
    }
    const path = spelledOnDisk(resolve(input.path));
    const projects = await readRoute<Array<{ id: string; name: string; path: string }>>(
      inject,
      '/api/projects',
    );
    const taken = projects.find(
      (project) =>
        normalizeProjectPath(spelledOnDisk(resolve(project.path))) === normalizeProjectPath(path),
    );
    if (taken) {
      throw new Error(
        `Already registered as «${taken.name}» (id ${taken.id}). Nothing to create: open it with open_page /projects focus ${taken.id}.`,
      );
    }
    const title = input.name ?? projectName(path);
    return {
      ...summaryText('summary-create-project', { title }),
      fields: [
        dataField('label-directory', path),
        dataField('label-title', title),
        await e2eOnboardField(path, inject),
      ],
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
  ...GROUP_ACTIONS,
  ...WORK_ACTIONS,
  ...PANEL_READ_ACTIONS,
  ...LOCAL_MODELS_ACTIONS,
  ...KIT_ACTIONS,
  ...TESTS_BLOCK_ACTIONS,
  ...GROUP_SOURCES_ACTIONS,
  ...ENTITY_EXTRA_ACTIONS,
  ...SETTINGS_EXTRA_ACTIONS,
  ...SIEVE_ACTIONS,
  ...DLP_EXTRA_ACTIONS,
  ...CONTOUR_MANAGE_ACTIONS,
  ...INTEGRATIONS_READ_ACTIONS,
  ...PORTABILITY_ACTIONS,
  ...MISC_EXTRA_ACTIONS,
  ...CHAT_EXTRA_ACTIONS,
  ...SANDBOX_ACTIONS,
  ...CONTOUR_AGENT_ACTIONS,
  ...CHAT_ACTIONS,
  ...PROJECT_CONFIG_ACTIONS,
  ...PROJECT_GIT_ACTIONS,
  ...PROJECT_RUNNER_ACTIONS,
  ...GAPS_CHAT_ACTIONS,
  ...GAPS_SETTINGS_ACTIONS,
  ...GAPS_PROJECT_ACTIONS,
  ...GAPS_TESTS_ACTIONS,
];

/**
 * Что добавление сделает с папкой e2e — строкой карточки, а не сюрпризом в
 * репозитории: маршрут добавления сам сводит свою папку в кейсы или заводит
 * заготовку со строкой в `.git/info/exclude`, и человек одобряет и это тоже.
 * Вид папки не прочёлся — общая строка обоих исходов: промолчать значило бы
 * снова обещать «только запись в реестре».
 */
async function e2eOnboardField(
  path: string,
  inject: InjectRoute,
): Promise<PanelActionPreviewField> {
  let folder: ProjectTestE2eFolder;
  try {
    folder = await readRoute<ProjectTestE2eFolder>(
      inject,
      `/api/project-tests/e2e?path=${encodeURIComponent(path)}`,
    );
  } catch {
    return textField('label-e2e-folder', 'value-e2e-onboard-maybe');
  }
  if (folder.state === 'missing') {
    return textField(
      'label-e2e-folder',
      folder.git ? 'value-e2e-onboard-create' : 'value-e2e-onboard-create-plain',
      { dir: PANEL_E2E_DIR },
    );
  }
  const dir = folder.dir ?? PANEL_E2E_DIR;
  return folder.specs > 0
    ? textField('label-e2e-folder', 'value-e2e-onboard-sync', { dir, count: folder.specs })
    : textField('label-e2e-folder', 'value-e2e-onboard-keep', { dir });
}
