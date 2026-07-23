/**
 * Единая фабрика ключей кеша. Строковых литералов по коду нет: иначе
 * инвалидация после правки конфига становится непредсказуемой.
 */
export const queryKeys = {
  location: ['location'] as const,
  /** Платформа, домашний каталог, оболочка — за сессию не меняются. */
  system: ['system'] as const,
  settings: ['settings'] as const,
  overview: ['overview'] as const,
  rules: ['rules'] as const,
  hooks: ['hooks'] as const,
  skills: ['skills'] as const,
  mcp: ['mcp'] as const,
  mcpHealth: (id: string) => ['mcp', id, 'health'] as const,
  permissions: ['permissions'] as const,
  env: ['env'] as const,
  groups: ['groups'] as const,
  automations: ['automations'] as const,
  /** Резервные копии: список обновляется после каждой записи в конфиг. */
  backups: ['backups'] as const,
  /** Лента изменений конфигурации: обновляется после каждой записи в конфиг. */
  history: ['history'] as const,
  /** Полный дифф одной копии: ключ зависит от её имени. */
  historyDiff: (name: string) => ['history', name, 'diff'] as const,
  /** Сырой глобальный CLAUDE.md — для страницы просмотра/правки целиком. */
  claudeMd: ['claude-md'] as const,
  /** Реестр проектов уровня конфигурации. */
  projects: ['projects'] as const,
  /** Сырой CLAUDE.md конкретного проекта. */
  projectRules: (id: string) => ['projects', id, 'rules'] as const,
  /** MCP-серверы конкретного проекта (.mcp.json). */
  projectMcp: (id: string) => ['projects', id, 'mcp'] as const,
  /** Права конкретного проекта (.claude/settings.json). */
  projectPermissions: (id: string) => ['projects', id, 'permissions'] as const,
  /** Глобальный поиск: ключ зависит от запроса, чтобы кешировать по строке. */
  search: (query: string) => ['search', query] as const,
};

/** Какие ключи обновлять при изменении конкретного домена на диске. */
export const DOMAIN_KEYS: Record<string, readonly (readonly string[])[]> = {
  // История зависит от резервных копий, а копия создаётся при любой записи в
  // конфиг, — поэтому лента обновляется вместе с каждым файловым доменом.
  rules: [queryKeys.rules, queryKeys.overview, queryKeys.history],
  hooks: [queryKeys.hooks, queryKeys.overview, queryKeys.history],
  skills: [queryKeys.skills, queryKeys.overview],
  mcp: [queryKeys.mcp, queryKeys.overview, queryKeys.history],
  permissions: [queryKeys.permissions, queryKeys.overview, queryKeys.history],
  env: [queryKeys.env, queryKeys.history],
  overview: [queryKeys.overview],
};
