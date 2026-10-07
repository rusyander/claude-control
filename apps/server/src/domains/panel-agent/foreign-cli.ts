import {
  PANEL_AGENT_BRIDGE_ID,
  PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
} from '@agentdeck/contracts/panel-agent';

/**
 * Агент панели у чужого CLI (Qwen Code, Codex; Gemini CLI — `gemini-agent.ts`,
 * OpenCode — `opencode-agent.ts`, Goose — `goose-agent.ts`, Kimi Code —
 * `kimi-agent.ts`) —
 * запуск и разбор его вывода.
 *
 * Обещание то же, что у `claude -p` (`runner.ts`): лёгкое окно — ни файловой
 * системы, ни оболочки, ни личных слоёв человека, из инструментов только
 * переходник панели, и его вызовы идут без вопроса CLI (подтверждение живёт в
 * карточке панели). Каждый флаг ниже снят с настоящего CLI на заглушке модели
 * (`.agent/provider-formats.agent.md` §panel agent), а не выведен из справки.
 *
 * Вывод чужого CLI сводится к ТЕМ ЖЕ событиям, что у Claude (`assistant` с
 * `text`/`tool_use`, `user` с `tool_result`, `result`): разбор хода в
 * `runner.ts` один, и окно агента не знает, какой CLI ему отвечал.
 */

export type PanelAgentDialect =
  'claude' | 'qwen' | 'codex' | 'gemini' | 'opencode' | 'goose' | 'kimi';

/** Какой запуск у провайдера; undefined — агент с этим CLI не работает. */
export function panelAgentDialectOf(providerId: string): PanelAgentDialect | undefined {
  if (
    providerId === 'claude' ||
    providerId === 'qwen' ||
    providerId === 'codex' ||
    providerId === 'gemini' ||
    providerId === 'opencode' ||
    providerId === 'goose' ||
    providerId === 'kimi'
  )
    return providerId;
  return undefined;
}

export const PANEL_AGENT_TOOL_PREFIX = `mcp__${PANEL_AGENT_BRIDGE_ID}__`;

/**
 * Встроенные инструменты Qwen Code 0.25, которые остаются в `--safe-mode`
 * (список `tools` кадра `system/init`). `--core-tools` в 0.25 их не снимает —
 * снимает только `--exclude-tools`. Новый инструмент новой версии сюда не
 * попадёт сам, поэтому ход сверяет `tools` кадра `init` и обрывается на первом
 * чужом (`foreignInitTools`): лучше отказ, чем агент с файловой системой.
 */
export const QWEN_EXCLUDED_TOOLS: readonly string[] = [
  'read_mcp_resource',
  'read_file',
  'zoom_image',
  'grep_search',
  'glob',
  'web_fetch',
  'run_shell_command',
  'edit',
  'write_file',
  'notebook_edit',
  'cron_create',
  'cron_list',
  'cron_delete',
  'list_agents',
  'agent',
  'task_stop',
  'send_message',
  'skill',
  'search_memory',
  'manage_memory',
  'record_artifact',
  'loop_wakeup',
  'get_goal',
  'update_goal',
  'tool_call',
  'tool_search',
  'report_findings',
  'enter_worktree',
  'exit_worktree',
];

/** Конфиг MCP для `--mcp-config` Qwen: тот же переходник, что у Claude, плюс потолок вызова. */
export function qwenBridgeConfig(bridge: BridgeLaunch): object {
  return {
    mcpServers: {
      [PANEL_AGENT_BRIDGE_ID]: {
        command: bridge.command,
        args: bridge.args,
        env: bridge.env,
        // Вызов ждёт клика человека по карточке — дольше стандартного ожидания CLI.
        timeout: PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
      },
    },
  };
}

/**
 * Argv хода Qwen Code. Разговор — в stdin (`-p` устарел, позиционный промпт
 * не нужен: stdin и есть промпт).
 * - `--safe-mode` — ни хуков, ни расширений, ни скиллов, ни личных серверов MCP,
 *   ни QWEN.md человека; вход в аккаунт и модель из настроек остаются (`--bare`
 *   снял бы и их — проверено: «No auth type is selected»);
 * - `--mcp-config` + `--allowed-mcp-server-names` — из MCP только переходник;
 * - `--exclude-tools` — встроенные инструменты сняты (см. `QWEN_EXCLUDED_TOOLS`);
 * - `--allowed-tools mcp__agentdeck-panel__*` — без него `-p` отклоняет вызов
 *   переходника («non-interactive mode cannot prompt»);
 * - `--chat-recording=false` — ход не ложится в сессии человека.
 * Системная дописка — аргументом: файла у Qwen нет, а обёртка npm запускается
 * без cmd.exe (`lib/win-shim.ts`), так что переводы строк доходят целыми.
 */
export function qwenPanelAgentArgs(files: {
  mcpConfig: string;
  systemPromptText: string;
  streamInput?: boolean;
}): string[] {
  return [
    '--safe-mode',
    ...(files.streamInput ? ['--input-format', 'stream-json'] : []),
    '--output-format',
    'stream-json',
    '--chat-recording=false',
    '--mcp-config',
    files.mcpConfig,
    '--allowed-mcp-server-names',
    PANEL_AGENT_BRIDGE_ID,
    '--exclude-tools',
    QWEN_EXCLUDED_TOOLS.join(','),
    '--allowed-tools',
    `${PANEL_AGENT_TOOL_PREFIX}*`,
    '--append-system-prompt',
    files.systemPromptText,
  ];
}

/** Что Qwen предложил модели сверх переходника — по кадру `system/init`. */
export function foreignInitTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (name): name is string => typeof name === 'string' && !name.startsWith(PANEL_AGENT_TOOL_PREFIX),
  );
}

/** Функции Codex 0.160, которые дали бы агенту руки сверх переходника (`codex features list`). */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'multi_agent',
  'goals',
  'view_image',
  'image_generation',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'skill_search',
  'tool_suggest',
  'hooks',
  'memories',
  'sleep_tool',
];

export interface BridgeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Строка TOML: JSON-строка — допустимая базовая строка TOML (те же экранирования). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Argv хода Codex (`codex exec`, разговор — в stdin через `-`).
 * - `--ignore-user-config` — `config.toml` человека не читается: ни его серверов
 *   MCP (встроенная таблица через `-c` их НЕ заменяет, а дополняет — проверено),
 *   ни хуков, ни профиля; вход в аккаунт остаётся (`CODEX_HOME/auth.json`);
 * - `--ignore-rules` — ни правил execpolicy; `--ephemeral` — сессия не пишется;
 * - `--sandbox read-only` + `--disable <функция>` — без оболочки и прочих рук;
 * - `default_tools_approval_mode="approve"` — без него `exec` отклоняет вызов
 *   переходника («approval policy is never»);
 * - `required=true` — ход ждёт, пока переходник отдаст список действий;
 * - `tool_timeout_sec` — вызов ждёт клика человека дольше стандартных 60 с;
 * - `developer_instructions` — системная дописка агента (строкой TOML);
 * - картинки — `-i <файл>` ДО прочих флагов: флаг вариадический.
 */
export function codexPanelAgentArgs(files: {
  bridge: BridgeLaunch;
  systemPromptText: string;
  imagePaths?: readonly string[];
}): string[] {
  const env = Object.entries(files.bridge.env)
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(',');
  const server = [
    `command=${tomlString(files.bridge.command)}`,
    `args=[${files.bridge.args.map(tomlString).join(',')}]`,
    `env={${env}}`,
    'default_tools_approval_mode="approve"',
    // Без `required` Codex 0.160 не ждёт каталог переходника: под нагрузкой скрипт
    // режима кода запускался раньше, и в `ALL_TOOLS` не было ни одного действия
    // панели (20 из 48 параллельных ходов). С ним ход ждёт переходник, а упавший
    // переходник — ошибка хода с причиной, а не агент без рук панели.
    'required=true',
    `tool_timeout_sec=${Math.ceil(PANEL_AGENT_MCP_TOOL_TIMEOUT_MS / 1000)}`,
  ].join(',');
  return [
    'exec',
    ...(files.imagePaths ?? []).flatMap((path) => ['-i', path]),
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '-c',
    'web_search="disabled"',
    '-c',
    `mcp_servers.${PANEL_AGENT_BRIDGE_ID}={${server}}`,
    '-c',
    `developer_instructions=${tomlString(files.systemPromptText)}`,
    '-',
  ];
}

/** Событие хода в форме Claude stream-json — то, что разбирает `runner.ts`. */
export interface PanelStreamBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

export interface PanelStreamEvent {
  type?: string;
  subtype?: string;
  tools?: unknown;
  message?: { content?: PanelStreamBlock[] };
  result?: unknown;
  is_error?: boolean;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  status?: string;
  result?: { content?: Array<{ type?: string; text?: string }> } | null;
  error?: { message?: string } | null;
}

interface CodexLine {
  type?: string;
  item?: CodexItem;
  message?: string;
  error?: { message?: string };
}

/**
 * Перевод JSONL `codex exec --json` в события Claude. Codex 0.160:
 * `item.started|completed` с `mcp_tool_call` (`server`, `tool`, `result.content`,
 * `error.message`, `status`), `item.completed` с `agent_message` (`text`),
 * `turn.completed` / `turn.failed` (`error.message`), `error` (`message`).
 * Итог (`result`) Codex не шлёт — он собирается на конце хода из последнего
 * ответа словами, как `result` у Claude.
 */
export function createCodexTranslator(): (line: CodexLine) => PanelStreamEvent[] {
  let lastText = '';
  let lastError = '';
  return (line) => {
    const item = line.item;
    if (line.type === 'item.started' && item?.type === 'mcp_tool_call') {
      return [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: item.id,
                name:
                  item.server === PANEL_AGENT_BRIDGE_ID
                    ? `${PANEL_AGENT_TOOL_PREFIX}${item.tool ?? ''}`
                    : `${item.server ?? '?'}/${item.tool ?? '?'}`,
              },
            ],
          },
        },
      ];
    }
    if (line.type === 'item.completed' && item?.type === 'mcp_tool_call') {
      const failed = item.status !== 'completed' || Boolean(item.error);
      // Отказ переходника (`isError` в ответе MCP) Codex 0.160 шлёт статусом
      // `failed` с пустым `error` и причиной в `result.content`. Без неё итог
      // действия в памяти разговора — «имя (failed): » без слова о причине.
      const reason = item.error?.message;
      return [
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: item.id,
                is_error: failed,
                content: failed && reason ? reason : (item.result?.content ?? []),
              },
            ],
          },
        },
      ];
    }
    if (line.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
      lastText = item.text;
      return [{ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } }];
    }
    if (line.type === 'error' && line.message) lastError = line.message;
    if (line.type === 'turn.completed')
      return [{ type: 'result', result: lastText, is_error: false }];
    if (line.type === 'turn.failed') {
      return [{ type: 'result', result: line.error?.message || lastError, is_error: true }];
    }
    return [];
  };
}

/** Ключ, адреса и модель Kimi из окружения — как человек сам запускает Kimi без конфига. */
const KIMI_ENV: readonly string[] = [
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'KIMI_CODE_BASE_URL',
  'KIMI_OAUTH_HOST',
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_MODEL_DISPLAY_NAME',
  'KIMI_MODEL_MAX_CONTEXT_SIZE',
  'KIMI_MODEL_MAX_OUTPUT_SIZE',
  'KIMI_MODEL_CAPABILITIES',
  'KIMI_MODEL_TEMPERATURE',
  'KIMI_MODEL_TOP_P',
  'KIMI_MODEL_THINKING_EFFORT',
  'KIMI_MODEL_ADAPTIVE_THINKING',
  'KIMI_MODEL_REASONING_KEY',
  'KIMI_MODEL_OUTPUT_FORMAT',
];

/** Переменные окружения, которые нужны самому CLI сверх общего списка агента. */
export function dialectEnvAllowlist(dialect: PanelAgentDialect): readonly string[] {
  // Каталог конфигурации и вход в аккаунт по документации CLI: без них ход
  // остался бы без логина человека. Ключ API — тот, которым человек сам
  // запускает этот CLI, а не ключ панели.
  if (dialect === 'qwen') return ['QWEN_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
  if (dialect === 'codex') return ['CODEX_HOME', 'CODEX_API_KEY'];
  // `GEMINI_CLI_HOME` человека сюда не идёт: у хода свой дом (`gemini-agent.ts`),
  // а вход человека переносится копиями файлов из его каталога.
  if (dialect === 'gemini') {
    return [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GEMINI_BASE_URL',
      'GEMINI_MODEL',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GENAI_USE_VERTEXAI',
    ];
  }
  // Провайдер и вход Goose человека — из окружения, как он сам запускает Goose;
  // переменные его провайдера добавляет `prepareGooseAgentRoot`.
  if (dialect === 'goose') return ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'GOOSE_DISABLE_KEYRING'];
  // `KIMI_CODE_HOME` человека сюда не идёт: у хода свой каталог (`kimi-agent.ts`).
  if (dialect === 'kimi') return KIMI_ENV;
  return [];
}
