import type { PanelPageTarget } from '@agentdeck/contracts/panel-agent';

/**
 * Разделы, у которых `focus` агента — это часть адреса, а не якорь в разметке.
 * Реестр сервера называет место словом (`/chat` + id разговора, `/tests` +
 * вкладка), а страница читает его из запроса: без перевода агент «открывал бы»
 * чат, но не тот разговор, и тесты, но не ту вкладку.
 */
const FOCUS_AS_SEARCH: Record<string, 'id' | 'tab'> = {
  '/chat': 'id',
  '/tests': 'tab',
  '/settings': 'tab',
};

/**
 * Якорь поля ключа контура. Имя повторяет `contourKeyAnchor` реестра сервера
 * (`routes/panel-agent/actions-contour.ts`) — сервер шлёт его в `focus`.
 */
export const CONTOUR_KEY_PREFIX = 'contour-key:';
/** Значение `?tab=` страницы контура: открыть мастер этого контура на шаге ключа. */
export const CONTOUR_KEY_TAB = 'key';

export function contourKeyAnchor(id: string): string {
  return `${CONTOUR_KEY_PREFIX}${id}`;
}

/**
 * Якорь пустого секрета MCP-сервера. Имя повторяет `mcpSecretAnchor` реестра
 * сервера (`routes/panel-agent/actions-config.ts`): страница MCP открывает форму
 * этого сервера (`?id=<имя>&tab=secret`) с полями пустых секретов.
 */
export const MCP_SECRET_PREFIX = 'mcp-secret:';
/** Значение `?tab=` страницы MCP: открыть форму сервера на полях секретов. */
export const MCP_SECRET_TAB = 'secret';

export function mcpSecretAnchor(name: string): string {
  return `${MCP_SECRET_PREFIX}${name}`;
}

/**
 * Якорь поля значения переменной окружения. Имя повторяет `envSecretAnchor`
 * реестра сервера (`routes/panel-agent/actions-hooks-env.ts`): страница env
 * открывает переменную с этим ключом (`?id=<ключ>&tab=secret`) на правку.
 */
export const ENV_SECRET_PREFIX = 'env-secret:';
/** Значение `?tab=` страницы env: `id` — ключ переменной, а не `источник:ключ`. */
export const ENV_SECRET_TAB = 'secret';

export function envSecretAnchor(key: string): string {
  return `${ENV_SECRET_PREFIX}${key}`;
}

/**
 * Якорь поля токена профиля эндпоинта. Имя повторяет `endpointTokenAnchor`
 * реестра сервера (`routes/panel-agent/actions-app.ts`): настройки открываются
 * на вкладке моделей с выбранным профилем (`?tab=models&id=<профиль>`).
 */
export const ENDPOINT_TOKEN_PREFIX = 'endpoint-token:';

export function endpointTokenAnchor(id: string): string {
  return `${ENDPOINT_TOKEN_PREFIX}${id}`;
}

/**
 * Якорь поля токена интеграции. Имя повторяет `integrationSecretAnchor` реестра
 * сервера (`routes/panel-agent/actions-app.ts`): карточки интеграций открыты
 * всегда, поэтому хватает вкладки `?tab=integrations`.
 */
export const INTEGRATION_SECRET_PREFIX = 'integration-secret:';

export function integrationSecretAnchor(id: string): string {
  return `${INTEGRATION_SECRET_PREFIX}${id}`;
}

/**
 * Вкладки настроек, где живут поля токенов. Имена — из `pages/Settings/model/tabs.ts`;
 * сущность страницу не импортирует, поэтому строки повторены здесь.
 */
const SETTINGS_ENDPOINTS_TAB = 'models';
const SETTINGS_INTEGRATIONS_TAB = 'integrations';

/** Фокус чата «проект»: агент создал проект и просил открыть его чат. */
export const CHAT_PROJECT_PREFIX = 'project:';

const SECRET_PREFIXES = [
  CONTOUR_KEY_PREFIX,
  MCP_SECRET_PREFIX,
  ENV_SECRET_PREFIX,
  ENDPOINT_TOKEN_PREFIX,
  INTEGRATION_SECRET_PREFIX,
];

/** Якорь — поле секрета (ключ контура, секрет MCP, env, токен), который вводит человек. */
export function isSecretAnchor(focus: string | undefined): boolean {
  return SECRET_PREFIXES.some((prefix) => focus?.startsWith(prefix));
}

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
}

/** Цель агента → переход роутера: путь, запрос и оставшийся якорь. */
export function pageNavigation(page: PanelPageTarget): PageNavigation {
  const [path = '/', query = ''] = page.route.split('?');
  const search = Object.fromEntries(new URLSearchParams(query));
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
  if (path === '/settings' && page.focus?.startsWith(INTEGRATION_SECRET_PREFIX)) {
    return { to: path, search: { ...search, tab: SETTINGS_INTEGRATIONS_TAB }, anchor: page.focus };
  }
  // Созданный проект открывается вкладкой чата: адрес без id — черновик нового
  // разговора в этом проекте, а не `?id=project:…`, которого нет ни в одном списке.
  if (path === '/chat' && page.focus?.startsWith(CHAT_PROJECT_PREFIX)) {
    return { to: path, search, project: page.focus.slice(CHAT_PROJECT_PREFIX.length) };
  }
  const key = FOCUS_AS_SEARCH[path];
  if (page.focus && key) return { to: path, search: { ...search, [key]: page.focus } };
  return { to: path, search, ...(page.focus ? { anchor: page.focus } : {}) };
}
