import type { ChatComposerMode } from './pageTarget.types';
import type { PanelPageTarget } from '@agentdeck/contracts/panel-agent';
import {
  CONTOUR_KEY_PREFIX,
  MCP_SECRET_PREFIX,
  ENV_SECRET_PREFIX,
  ENDPOINT_TOKEN_PREFIX,
  INTEGRATION_SECRET_PREFIX,
  INTEGRATION_CARD_PREFIX,
  DLP_RULE_PREFIX,
} from './pageTarget.constants';

export function queryOf(search: Record<string, string>): string {
  const query = new URLSearchParams(search).toString();
  return query ? `?${query}` : '';
}

/** Значение `?tab=` страницы контура: открыть мастер этого контура на шаге ключа. */
export const CONTOUR_KEY_TAB = 'key';

/** Значение `?tab=` страницы MCP: открыть форму сервера на полях секретов. */
export const MCP_SECRET_TAB = 'secret';

/** Значение `?tab=` страницы env: `id` — ключ переменной, а не `источник:ключ`. */
export const ENV_SECRET_TAB = 'secret';

/**
 * Вкладки настроек, где живут поля токенов. Имена — из `pages/Settings/model/tabs.constants.ts`;
 * сущность страницу не импортирует, поэтому строки повторены здесь.
 */
export const SETTINGS_ENDPOINTS_TAB = 'models';

export const SETTINGS_INTEGRATIONS_TAB = 'integrations';

/** Фокус чата «проект»: агент создал проект и просил открыть его чат. */
export const CHAT_PROJECT_PREFIX = 'project:';

/** Вкладка правил /dlp — из `pages/Dlp/model/tabs.ts`. */
export const DLP_RULES_TAB = 'rules';

export const LIST_ALL_TAB_PAGES = new Set(['/rules', '/scripts']);

/** Вкладка-отбор «Все» правил и скриптов (`pages/{Rules,Scripts}/model/tabs.ts`). */
export const LIST_ALL_TAB = 'all';

/**
 * Разделы, у которых `focus` агента — это часть адреса, а не якорь в разметке.
 * Реестр сервера называет место словом (`/chat` + id разговора, `/tests` +
 * вкладка), а страница читает его из запроса: без перевода агент «открывал бы»
 * чат, но не тот разговор, и тесты, но не ту вкладку.
 */
export const FOCUS_AS_SEARCH: Record<string, 'id' | 'tab'> = {
  '/chat': 'id',
  '/projects': 'id',
  '/tests': 'tab',
  '/settings': 'tab',
};

export interface PageNavigation {
  to: string;
  search: Record<string, string>;
  /** Якорь, который осталось найти на странице; пусто — `focus` ушёл в адрес. */
  anchor?: string;
  /**
   * Id проекта из реестра, чью вкладку открыть в чате. Адресом этого не
   * передать: проект чата — вкладка рабочего места, а не параметр запроса.
   */
  project?: string;
  /**
   * Режим композера, в котором открыть чат (`/chat?mode=deck`). Адресом страница
   * его не читает: режим — состояние поля ввода, а не ссылка, и после F5 он не
   * должен навязываться снова.
   */
  composerMode?: ChatComposerMode;
}

export function composerModeOf(value: string | undefined): ChatComposerMode | undefined {
  return value === 'deck' || value === 'image' ? value : undefined;
}

/** Цель агента → переход роутера: путь, запрос и оставшийся якорь. */
export function pageNavigation(page: PanelPageTarget): PageNavigation {
  const [path = '/', query = ''] = page.route.split('?');
  const search = Object.fromEntries(new URLSearchParams(query));
  if (path === '/chat' && 'mode' in search) {
    const composerMode = composerModeOf(search.mode);
    delete search.mode;
    const rest = pageNavigation({ ...page, route: path + queryOf(search) });
    return composerMode ? { ...rest, composerMode } : rest;
  }
  // Поля ключа нет в разметке, пока мастер закрыт: адрес велит странице открыть
  // мастер этого контура на шаге ключа, а якорь потом доводит фокус до поля.
  if (path === '/platform' && page.focus?.startsWith(CONTOUR_KEY_PREFIX)) {
    const id = page.focus.slice(CONTOUR_KEY_PREFIX.length);
    return { to: path, search: { ...search, id, tab: CONTOUR_KEY_TAB }, anchor: page.focus };
  }
  // Форма MCP-сервера закрыта, пока её не открыли: адрес открывает форму этого
  // сервера на полях секретов, якорь доводит фокус до пустого поля.
  if (path === '/mcp' && page.focus?.startsWith(MCP_SECRET_PREFIX)) {
    const id = page.focus.slice(MCP_SECRET_PREFIX.length);
    return { to: path, search: { ...search, id, tab: MCP_SECRET_TAB }, anchor: page.focus };
  }
  if (path === '/env' && page.focus?.startsWith(ENV_SECRET_PREFIX)) {
    const id = page.focus.slice(ENV_SECRET_PREFIX.length);
    return { to: path, search: { ...search, id, tab: ENV_SECRET_TAB }, anchor: page.focus };
  }
  if (path === '/settings' && page.focus?.startsWith(ENDPOINT_TOKEN_PREFIX)) {
    const id = page.focus.slice(ENDPOINT_TOKEN_PREFIX.length);
    return { to: path, search: { ...search, id, tab: SETTINGS_ENDPOINTS_TAB }, anchor: page.focus };
  }
  if (
    path === '/settings' &&
    (page.focus?.startsWith(INTEGRATION_SECRET_PREFIX) ||
      page.focus?.startsWith(INTEGRATION_CARD_PREFIX))
  ) {
    return { to: path, search: { ...search, tab: SETTINGS_INTEGRATIONS_TAB }, anchor: page.focus };
  }
  // Созданный проект открывается вкладкой чата: адрес без id — черновик нового
  // разговора в этом проекте, а не `?id=project:…`, которого нет ни в одном списке.
  if (path === '/chat' && page.focus?.startsWith(CHAT_PROJECT_PREFIX)) {
    return { to: path, search, project: page.focus.slice(CHAT_PROJECT_PREFIX.length) };
  }
  // Список прав виртуальный: строки вне экрана нет в DOM, и якорь не нашёлся бы.
  // `?show=` велит странице снять фильтры и докрутить до строки, якорь — подсветить.
  if (path === '/permissions' && page.focus) {
    return { to: path, search: { ...search, show: page.focus }, anchor: page.focus };
  }
  // Вкладка раздела помнится у зрителя, и строка, стоящая на другой вкладке,
  // не нашлась бы — подсветка молча не срабатывала. Правила DLP живут на своей
  // вкладке; правило и скрипт есть на «Все» при любом их состоянии.
  if (path === '/dlp' && page.focus?.startsWith(DLP_RULE_PREFIX)) {
    return { to: path, search: { ...search, tab: DLP_RULES_TAB }, anchor: page.focus };
  }
  if (LIST_ALL_TAB_PAGES.has(path) && page.focus) {
    return { to: path, search: { ...search, tab: LIST_ALL_TAB }, anchor: page.focus };
  }
  // Вкладку группы (глобальные или проектные) знает только страница — по
  // области группы; `?show=` просит её выбрать, якорь подсвечивает карточку.
  if (path === '/groups' && page.focus) {
    return { to: path, search: { ...search, show: page.focus }, anchor: page.focus };
  }
  const key = FOCUS_AS_SEARCH[path];
  if (page.focus && key) return { to: path, search: { ...search, [key]: page.focus } };
  return { to: path, search, ...(page.focus ? { anchor: page.focus } : {}) };
}
