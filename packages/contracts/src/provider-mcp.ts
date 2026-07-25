import { object, string, array, record, enum as zodEnum, boolean, type infer as Infer } from 'zod';

/**
 * Универсальная модель MCP-сервера — общий межвендорный субсет.
 *
 * Разные CLI хранят MCP-серверы в разных файлах и форматах (Claude — JSON в
 * ~/.claude.json, Gemini — JSON в settings.json, Cursor — JSON в ~/.cursor/mcp.json,
 * Codex — TOML-таблицы [mcp_servers.<name>], OpenCode — объект `mcp` в
 * opencode.json с формой `{type:'local', command:[…]}`), но суть у всех одна. Этот
 * субсет описывает то, что переносимо между ними: имя, транспорт и параметры
 * подключения.
 *
 * Провайдер-специфику (Claude OAuth/tools/health, codex bearer_token, gemini
 * trust/timeout и т.п.) модель НЕ включает — это адаптируется отдельно у своего
 * провайдера. Здесь только два транспорта: `stdio` (локальный процесс) и `http`
 * (стримируемый HTTP). Раздел Claude остаётся на своей богатой модели McpServer.
 */
export const universalMcpTransportSchema = zodEnum(['stdio', 'http']);
export type UniversalMcpTransport = Infer<typeof universalMcpTransportSchema>;

export const universalMcpServerSchema = object({
  /** Имя сервера в конфиге — оно же идентификатор. */
  name: string(),
  transport: universalMcpTransportSchema,
  /** Для stdio: команда запуска и аргументы. */
  command: string().optional(),
  args: array(string()).default([]),
  /** Переменные окружения процесса (только stdio). */
  env: record(string(), string()).default({}),
  /** Для http: адрес стримируемого HTTP-сервера. */
  url: string().optional(),
  /** HTTP-заголовки (только http). */
  headers: record(string(), string()).default({}),
});

export type UniversalMcpServer = Infer<typeof universalMcpServerSchema>;

export const universalMcpServerDraftSchema = object({
  name: string().min(1),
  transport: universalMcpTransportSchema,
  command: string().optional(),
  args: array(string()).default([]),
  env: record(string(), string()).default({}),
  url: string().optional(),
  headers: record(string(), string()).default({}),
});

export type UniversalMcpServerDraft = Infer<typeof universalMcpServerDraftSchema>;

/**
 * Ответ раздела универсальных MCP-серверов (Gemini/Codex). Помимо самого списка
 * несёт метаданные для адаптации интерфейса: формат файла, его путь, обнаружен
 * ли CLI и данные активного провайдера.
 *
 * `readOnly` = true, когда формат файла не распознан (например, config.toml не
 * парсится): раздел показывается только на чтение, запись запрещена (fail-closed).
 */
export const providerMcpInfoSchema = object({
  servers: array(universalMcpServerSchema),
  /** Id активного провайдера (`codex` / `gemini`). */
  providerId: string(),
  /** Человекочитаемое имя активного провайдера — для заголовка раздела. */
  providerName: string(),
  /**
   * Формат файла конфигурации: `json` — объект `mcpServers` (Gemini
   * settings.json, Cursor mcp.json), `toml` — таблицы `[mcp_servers.<name>]`
   * (Codex config.toml), `opencode-json` — объект `mcp` с формой
   * `{type:'local'|'remote'}` (OpenCode opencode.json), `continue-yaml` — СПИСОК
   * `mcpServers` с именем внутри записи (Continue config.yaml), `goose-yaml` —
   * ОТОБРАЖЕНИЕ `extensions` «имя → запись» (Goose config.yaml).
   */
  format: zodEnum(['json', 'toml', 'opencode-json', 'continue-yaml', 'goose-yaml']),
  /** Абсолютный путь к файлу конфигурации MCP активного провайдера. */
  filePath: string(),
  /** Обнаружен ли CLI провайдера (по наличию его каталога конфигурации). */
  cliDetected: boolean(),
  /** Формат не распознан → раздел только для чтения (запись запрещена). */
  readOnly: boolean().default(false),
  /** Текст ошибки, если формат не распознан. */
  error: string().optional(),
});

export type ProviderMcpInfo = Infer<typeof providerMcpInfoSchema>;
