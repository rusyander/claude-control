import type { SessionHooks } from '@agentdeck/contracts/core/session-carry';

/**
 * Настройки профиля поверх личных. Только хуки: прогон идёт через ядро, и ядро несёт их полем
 * `session.hooks` в свой `--settings` (s12). Иных ключей у ядра нет — перенос отказал бы по имени.
 */
export interface ProfileSettings {
  hooks?: SessionHooks;
}

/** Что реестр прогонов кладёт в запуск: флаги, переменные, серверы, строка, настройки. */
export interface GroupRunProfile {
  /** `--strict-mcp-config`: всё, что не приехало своим `--mcp-config`, снято. */
  args: string[];
  /** Подключения claude.ai снимаются переменной — флаг их не касается. */
  env: Record<string, string>;
  /** Оставленные серверы — своим `--mcp-config`. Нет — серверы прогона не трогаются. */
  mcp?: { ids: string[]; config: unknown };
  /** Строка к системному промпту: что подключено, что снято и как попросить. */
  note: string;
  /** Настройки поверх личных: хуки. Пусто — ничего не тронуто. */
  settings: ProfileSettings;
}
