import { integrationKeys } from '@entities/Integration';
import { pluginsKey } from '@entities/Plugin';
import { projectsKey } from '@entities/Project';
import { projectGitKey } from '@entities/ProjectGit';
import { projectRunnerKey } from '@entities/ProjectRunner';
import { testKeys } from '@entities/ProjectTest';
import { scriptsKey } from '@entities/Script';
import { DOMAIN_KEYS, queryKeys } from '@shared/api/query-keys';

type Keys = readonly (readonly unknown[])[];

/** Все файловые разделы конфига: откат истории и копия трогают любой из них. */
const CONFIG_FILE_KEYS: Keys = [
  ...(DOMAIN_KEYS.rules ?? []),
  ...(DOMAIN_KEYS.hooks ?? []),
  ...(DOMAIN_KEYS.skills ?? []),
  ...(DOMAIN_KEYS.mcp ?? []),
  ...(DOMAIN_KEYS.permissions ?? []),
  ...(DOMAIN_KEYS.env ?? []),
];

/**
 * Что перечитать после правки агента, по разделу действия (`section` кадра
 * `agent-decided`). Одна карта на все разделы: наблюдатель файлов замечает
 * запись в `~/.claude` не всегда (правка контура, реестра проектов, настроек
 * панели идёт мимо файлов конфига), и открытая страница стояла бы на старом
 * снимке до F5. Раздел без записи — перечитывать нечего (`navigation`, `help`).
 * Полноту по реестру сервера держит `sectionKeys.test.ts`.
 */
export const SECTION_QUERY_KEYS: Readonly<Record<string, Keys>> = {
  rules: DOMAIN_KEYS.rules ?? [queryKeys.rules],
  hooks: DOMAIN_KEYS.hooks ?? [queryKeys.hooks],
  skills: DOMAIN_KEYS.skills ?? [queryKeys.skills],
  mcp: DOMAIN_KEYS.mcp ?? [queryKeys.mcp],
  permissions: DOMAIN_KEYS.permissions ?? [queryKeys.permissions],
  env: DOMAIN_KEYS.env ?? [queryKeys.env],
  // Сырой CLAUDE.md и разобранные из него правила — один файл.
  'claude-md': DOMAIN_KEYS.rules ?? [queryKeys.claudeMd],
  // Скрипт хука живёт рядом с хуками: удаление скрипта меняет и их карточки.
  scripts: [scriptsKey, queryKeys.hooks],
  // Группа несёт правила, скиллы, MCP и env: включение пишет их все.
  groups: [queryKeys.groups, ...CONFIG_FILE_KEYS],
  // Плагин приносит свои скиллы, команды и MCP-серверы.
  plugins: [pluginsKey, queryKeys.skills, queryKeys.mcp, queryKeys.overview],
  history: [queryKeys.history, queryKeys.backups, queryKeys.claudeMd, ...CONFIG_FILE_KEYS],
  settings: [queryKeys.settings],
  // Смена провайдера меняет содержимое почти каждой страницы — перечитываем всё.
  provider: [[]],
  // Применение профиля пишет переменные в конфиг CLI (у Claude — env в
  // settings.json): без env страница переменных стояла бы на старом снимке.
  endpoints: [
    queryKeys.endpoints('').slice(0, 1),
    queryKeys.settings,
    ...(DOMAIN_KEYS.env ?? [queryKeys.env]),
  ],
  integrations: [integrationKeys.root, queryKeys.settings],
  dlp: [queryKeys.dlp, queryKeys.settings],
  // Список проектов живёт под двумя ключами: реестр и выбор проекта в чате,
  // а новый чат агента — в дереве `chats`.
  projects: [
    queryKeys.projects,
    projectsKey,
    ['chats'],
    // Git, копии, их настройки и dev-серверы проекта — действия агента над проектом.
    projectGitKey,
    projectRunnerKey,
    queryKeys.groupChoicesOf('').slice(0, 2),
  ],
  tests: [testKeys.root],
  contour: [queryKeys.platforms],
  // Действия агента над чатами: список и лента, дерево и план разделения,
  // группа чата, заметки главным чатам деревьев.
  chat: [
    ['chats'],
    ['chat'],
    ['chat-tree'],
    ['split'],
    ['chat-group-settings'],
    queryKeys.chatEscalations,
  ],
  // Стоп сессии вне панели: список идущих и сессий аналитики.
  analytics: [['analytics']],
  // Перенос и его отмена: след переноса, подписки, верность и паспорт цели.
  portability: [['portability']],
};

/** Ключи раздела; неизвестный раздел — пусто, ничего не перечитываем. */
export function sectionQueryKeys(section: string | undefined): Keys {
  return (section && SECTION_QUERY_KEYS[section]) || [];
}
