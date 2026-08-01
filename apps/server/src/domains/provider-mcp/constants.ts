/**
 * Что панель МОДЕЛИРУЕТ у каждого формата.
 *
 * Перечисленные ключи пересобираются при записи из черновика; всё остальное в
 * записи (таймауты, `cwd`, `enabled`, фильтры инструментов, любые будущие поля)
 * переносится из прежней записи по значению — round-trip ничего не теряет
 * (`preserveUnmodelled` в `values.ts`).
 */

/** `json` (Gemini/Cursor): остальное — `cwd`, `enabled`, таймауты, фильтры инструментов. */
export const JSON_MODELLED_KEYS = ['command', 'args', 'env', 'url', 'httpUrl', 'headers'];

/** `opencode-json`: остальное — `enabled` и любые неизвестные/будущие поля. */
export const OPENCODE_MODELLED_KEYS = ['type', 'command', 'environment', 'url', 'headers'];

/** Codex: остальное — `startup_timeout_sec`, `tool_timeout_sec`, `enabled`, `env_vars`, … */
export const CODEX_MODELLED_KEYS = ['command', 'args', 'env', 'url', 'http_headers'];

/**
 * Continue: остальное — `cwd`, `connectionTimeout`, `apiKey`, будущие поля.
 * `requestOptions` в списке потому, что панель ведёт его подключ `headers`;
 * прочие подключи сохраняются отдельно (см. `buildContinueRaw`).
 */
export const CONTINUE_MODELLED_KEYS = [
  'name',
  'type',
  'command',
  'args',
  'env',
  'url',
  'requestOptions',
];

/** Задокументированные удалённые транспорты Continue (у остальных — stdio). */
export const CONTINUE_REMOTE_TYPES = ['sse', 'streamable-http'];

/**
 * Goose: остальное — `description`, `bundled`, `timeout`, `cwd`, `env_keys`,
 * `available_tools`, будущие поля. `enabled` в списке потому, что панель его
 * ВЫСТАВЛЯЕТ у новой записи (иначе Goose расширение не поднимет), но у
 * существующей сохраняет как было.
 */
export const GOOSE_MODELLED_KEYS = ['type', 'name', 'cmd', 'args', 'envs', 'uri', 'headers'];

/** Задокументированные удалённые транспорты Goose (у остальных — stdio). */
export const GOOSE_REMOTE_TYPES = ['sse', 'streamable_http'];
