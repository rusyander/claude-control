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
};

/** Какие ключи обновлять при изменении конкретного домена на диске. */
export const DOMAIN_KEYS: Record<string, readonly (readonly string[])[]> = {
  rules: [queryKeys.rules, queryKeys.overview],
  hooks: [queryKeys.hooks, queryKeys.overview],
  skills: [queryKeys.skills, queryKeys.overview],
  mcp: [queryKeys.mcp, queryKeys.overview],
  permissions: [queryKeys.permissions, queryKeys.overview],
  env: [queryKeys.env],
  overview: [queryKeys.overview],
};
