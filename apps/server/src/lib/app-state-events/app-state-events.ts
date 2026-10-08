/**
 * Какие разделы интерфейса перечитать после записи СОБСТВЕННОГО состояния
 * панели — настроек, групп, выбора группы у чата и у проекта.
 *
 * Поток `/api/events` раньше нёс только изменения файлов конфигурации
 * (`config-watcher`): `state.json` и `group-sources.json` на нём не появлялись.
 * Открытая вкладка чата поэтому не видела ни группы, выбранной в соседней
 * вкладке или с телефона, ни удалённой группы, ни языка, сменённого в другой
 * вкладке, — до F5 (WA 28.09). Прогон при этом шёл правильно: сервер решает
 * заново на каждый ход, — врал только экран.
 *
 * Решаем по успешному изменяющему запросу, а не по записи файла: все, кто
 * меняет это состояние, — вкладки, телефон, агент панели (`inject`) — ходят
 * через маршруты, а у записи `state.json` на диске не видно, ЧТО изменилось
 * (туда же каждую секунду пишутся связи чатов). Домены — те же строки, что у
 * наблюдателя файлов; веб сводит их к ключам запросов (`DOMAIN_KEYS`).
 */

/** Разделы состояния панели на потоке событий. */
export const APP_STATE_DOMAINS = {
  settings: 'settings',
  groups: 'groups',
} as const;

const EVERYTHING = [APP_STATE_DOMAINS.settings, APP_STATE_DOMAINS.groups];

/** Маршруты, чья успешная запись меняет состояние панели, и что именно. */
const RULES: ReadonlyArray<{ test: (path: string) => boolean; domains: string[] }> = [
  { test: (path) => path === '/api/settings', domains: [APP_STATE_DOMAINS.settings] },
  // Импорт снимка и смена каталога заменяют состояние целиком.
  { test: (path) => path === '/api/settings/import', domains: EVERYTHING },
  { test: (path) => path === '/api/location', domains: EVERYTHING },
  {
    test: (path) => path === '/api/groups' || path.startsWith('/api/groups/'),
    domains: [APP_STATE_DOMAINS.groups],
  },
  { test: (path) => path === '/api/projects/group-choice', domains: [APP_STATE_DOMAINS.groups] },
  {
    test: (path) => /^\/api\/chat\/[^/]+\/group-settings$/.test(path),
    domains: [APP_STATE_DOMAINS.groups],
  },
];

/**
 * Разделы для рассылки после ответа на запрос; пусто — рассылать нечего.
 * Чтение и отказ (не 2xx) ничего не меняют.
 */
export function appStateDomains(method: string, url: string, statusCode: number): string[] {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return [];
  if (statusCode < 200 || statusCode >= 300) return [];
  const path = url.split('?')[0] ?? '';
  const domains = new Set<string>();
  for (const rule of RULES) {
    if (rule.test(path)) for (const domain of rule.domains) domains.add(domain);
  }
  return [...domains];
}
