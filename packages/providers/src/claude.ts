import type { CliRunFacts } from './types.ts';

/**
 * Claude Code. Источники: каталог панели `apps/server/src/providers/claude.ts` (до переезда),
 * `lib/cli-args/cli-args.ts` (глубина), `domains/local-models/run-env.ts` (пределы локальной
 * модели), `domains/chat/limit-journal` (событие окна).
 */
export const claudeRunFacts: CliRunFacts = {
  id: 'claude',
  name: 'Claude Code',
  status: 'verified',
  binary: { command: 'claude', windowsCommand: 'claude.cmd' },
  // Вход учётной записью Claude (подписка) — `domains/account.ts`, `domains/credentials`.
  login: 'account',
  // API — Anthropic, ключ `ANTHROPIC_API_KEY`. Адрес — корень хоста из документации Anthropic
  // (Messages API: `POST https://api.anthropic.com/v1/messages`); путь диалекта дописывает звено.
  vendorApi: {
    kind: 'anthropic',
    keyVars: ['ANTHROPIC_API_KEY'],
    baseUrl: 'https://api.anthropic.com',
  },
  cliRunnable: true,
  channels: [
    // Свой адрес: задокументирован `ANTHROPIC_BASE_URL` («the variable that points Claude Code
    // at the gateway») плюс `ANTHROPIC_MODEL`. Ключ документация предлагает класть в
    // `ANTHROPIC_AUTH_TOKEN` (заголовок `Authorization: Bearer`); `ANTHROPIC_API_KEY`
    // (`x-api-key`) требует ещё и одобрения в интерактивной сессии.
    {
      via: 'env',
      form: 'vars',
      dialect: 'anthropic-messages',
      baseUrlVar: 'ANTHROPIC_BASE_URL',
      modelVar: 'ANTHROPIC_MODEL',
      keyVar: 'ANTHROPIC_AUTH_TOKEN',
    },
  ],
  // `--effort <уровень>`; белый список — чужого в командную строку не пустим.
  effort: { argv: ['--effort', '{effort}'], values: ['low', 'medium', 'high', 'xhigh', 'max'] },
  // Каталог Anthropic (models.dev). Алиасы (`opus`, `sonnet`, `haiku`) CLI разворачивает сам.
  modelVendors: ['anthropic'],
  // Лестница уровня ядра — алиасы `--model` (справка бинаря 2.1.310: «an alias for the latest
  // model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name»), порядок силы — тот же,
  // что у подбора панели (`MODEL_RANK` контрактов). Полное имя (`claude-opus-5-5`) — та же ступень.
  modelRungs: [
    { model: 'haiku', ids: ['claude-haiku'] },
    { model: 'sonnet', ids: ['claude-sonnet'] },
    { model: 'opus', ids: ['claude-opus'] },
    { model: 'fable', ids: ['claude-fable'] },
  ],
  // Окно и сроки локальной модели — окружением прогона (бинарь 2.1.286, разбор 13.10 и L4b):
  // без них Claude Code считает окно облачным и рвёт законный разбор длинного промпта.
  // Порядок — порядок записи в `localRunEnv`.
  limitsChannel: {
    via: 'env',
    vars: [
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
      'CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS',
      'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
      'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS',
      'API_TIMEOUT_MS',
      'CLAUDE_CODE_RETRY_WATCHDOG',
      'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
      'MAX_MCP_OUTPUT_TOKENS',
    ],
  },
  // Состояние окна подписки — событие потока `stream-json` (`domains/chat/limit-journal`).
  windowEvent: { type: 'rate_limit_event' },
};
