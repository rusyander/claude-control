import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PANEL_AGENT_BRIDGE_ID,
  PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
} from '@agentdeck/contracts/panel-agent';
import { parseProviderJsonObject } from '../../lib/provider-json.ts';
import {
  PANEL_AGENT_TOOL_PREFIX,
  type BridgeLaunch,
  type PanelStreamEvent,
} from './foreign-cli.ts';

/**
 * Агент панели у Gemini CLI 0.62 — то же обещание лёгкого окна, что у Claude.
 *
 * Флагов «без личных слоёв» у Gemini нет, и глобальный `~/.gemini/GEMINI.md`
 * читается всегда, из домашнего каталога CLI. Поэтому у хода свой дом:
 * `GEMINI_CLI_HOME` = временная папка хода, она же рабочая (задокументировано,
 * docs/cli/enterprise.md «User isolation»). В нём — только наше: настройки с
 * переходником, правило «только переходник» и копии файлов входа человека.
 * Снято на настоящем gemini с заглушкой модели (`.agent/provider-formats.agent.md`
 * §gemini panel agent): модели объявлен один инструмент, хуки, MCP, скиллы и
 * GEMINI.md человека не доходят.
 */

/**
 * Файлы входа в аккаунт из `~/.gemini` человека — копиями в дом хода: ключ в
 * `.env`, OAuth в `oauth_creds.json` или в зашифрованном `gemini-credentials.json`
 * (ключ шифра — имя машины и пользователя, не путь, так что копия читается),
 * активная учётка в `google_accounts.json`. Папка хода удаляется в конце хода.
 */
export const GEMINI_AUTH_FILES: readonly string[] = [
  '.env',
  'oauth_creds.json',
  'google_accounts.json',
  'gemini-credentials.json',
];

/**
 * Правило Policy Engine: запрещено всё, кроме переходника. Запрет без
 * `argsPattern` убирает инструмент из объявления модели целиком — это
 * разрешающий список, и встроенный инструмент новой версии сюда не пролезет
 * (`tools.exclude` — устаревший запрещающий список). `toolName` обязателен и у
 * правила с `mcpName`: без него файл правил отклоняется целиком.
 */
export const GEMINI_AGENT_POLICY = [
  '[[rule]]',
  'toolName = "*"',
  'decision = "deny"',
  'priority = 100',
  '',
  '[[rule]]',
  'toolName = "*"',
  `mcpName = "${PANEL_AGENT_BRIDGE_ID}"`,
  'decision = "allow"',
  'priority = 200',
  '',
].join('\n');

/** Каталог `.gemini` человека: `GEMINI_CLI_HOME`, иначе домашний. */
export function userGeminiDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GEMINI_CLI_HOME?.trim();
  return join(raw ? resolve(raw) : homedir(), '.gemini');
}

interface GeminiUserSettings {
  security?: { auth?: unknown };
  model?: { name?: unknown };
}

/** Из настроек человека — только способ входа и модель; прочее (хуки, MCP) не нужно. */
function userAuthAndModel(userDir: string): Record<string, unknown> {
  let parsed: GeminiUserSettings;
  try {
    parsed = parseProviderJsonObject<GeminiUserSettings>(
      readFileSync(join(userDir, 'settings.json'), 'utf8'),
    );
  } catch {
    // Нет файла или он не JSON — вход тогда из окружения (`GEMINI_API_KEY` и т.п.).
    return {};
  }
  const out: Record<string, unknown> = {};
  const auth = parsed.security?.auth;
  if (auth && typeof auth === 'object') out.security = { auth };
  const model = parsed.model?.name;
  if (typeof model === 'string' && model.trim()) out.model = { name: model };
  return out;
}

/** Настройки дома хода: переходник без вопроса CLI, ни скиллов, ни хуков. */
export function geminiAgentSettings(
  bridge: BridgeLaunch,
  user: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...user,
    mcpServers: {
      [PANEL_AGENT_BRIDGE_ID]: {
        command: bridge.command,
        args: bridge.args,
        env: bridge.env,
        // Подтверждение живёт в карточке панели, не в CLI.
        trust: true,
        // Вызов ждёт клика человека по карточке — дольше стандартного ожидания CLI.
        timeout: PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
      },
    },
    skills: { enabled: false },
    hooksConfig: { enabled: false },
  };
}

/**
 * Дом хода в папке хода `dir`; возвращает добавку к окружению процесса.
 * - `GEMINI_CLI_TRUST_WORKSPACE` — без доверия папке `-p` отказывает сразу, а
 *   папка — наша пустая временная;
 * - `GEMINI_SYSTEM_MD` — системный промпт агента целиком вместо промпта CLI.
 */
export function prepareGeminiAgentHome(options: {
  dir: string;
  bridge: BridgeLaunch;
  systemPromptText: string;
  userDir?: string;
}): Record<string, string> {
  const userDir = options.userDir ?? userGeminiDir();
  const geminiDir = join(options.dir, '.gemini');
  mkdirSync(join(geminiDir, 'policies'), { recursive: true });
  writeFileSync(
    join(geminiDir, 'settings.json'),
    JSON.stringify(geminiAgentSettings(options.bridge, userAuthAndModel(userDir)), null, 2),
    'utf8',
  );
  writeFileSync(join(geminiDir, 'policies', 'agent.toml'), GEMINI_AGENT_POLICY, 'utf8');
  for (const name of GEMINI_AUTH_FILES) {
    const from = join(userDir, name);
    if (existsSync(from)) copyFileSync(from, join(geminiDir, name));
  }
  const systemMd = join(options.dir, 'agent-system.md');
  writeFileSync(systemMd, options.systemPromptText, 'utf8');
  return {
    GEMINI_CLI_HOME: options.dir,
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    GEMINI_SYSTEM_MD: systemMd,
  };
}

/**
 * Argv хода: разговор — в stdin (`-p ""` включает безголовый режим, stdin
 * дописывается к пустому промпту); `--allowed-mcp-server-names` — из MCP только
 * переходник, даже если в настройках окажется чужой сервер.
 */
export function geminiPanelAgentArgs(): string[] {
  return ['-p', '', '-o', 'stream-json', '--allowed-mcp-server-names', PANEL_AGENT_BRIDGE_ID];
}

/** `mcp_agentdeck-panel_list_sections` → имя Claude `mcp__agentdeck-panel__list_sections`. */
const GEMINI_BRIDGE_PREFIX = `mcp_${PANEL_AGENT_BRIDGE_ID}_`;

function claudeToolName(name: string): string {
  return name.startsWith(GEMINI_BRIDGE_PREFIX)
    ? `${PANEL_AGENT_TOOL_PREFIX}${name.slice(GEMINI_BRIDGE_PREFIX.length)}`
    : name;
}

interface GeminiLine {
  type?: string;
  role?: string;
  content?: unknown;
  delta?: boolean;
  session_id?: string;
  parameters?: unknown;
  severity?: string;
  tool_name?: string;
  tool_id?: string;
  status?: string;
  output?: unknown;
  error?: { message?: string } | null;
  message?: string;
}

/**
 * Перевод `gemini -o stream-json` в события Claude. Gemini 0.62: `message`
 * (`role`, `content`, у ответа `delta: true` — очередной кусок), `tool_use`
 * (`tool_name`, `tool_id`), `tool_result` (`tool_id`, `status`, `output`,
 * `error.message`), `error` (`message`), `result` (`status`, `error.message`).
 * Куски ответа копятся и уходят одним текстом на границе — перед вызовом
 * инструмента и в конце хода: так разбор хода видит заметку перед действием
 * целым блоком, как у Claude. Итог — последний такой блок.
 */
export function createGeminiTranslator(): (line: GeminiLine) => PanelStreamEvent[] {
  let pending = '';
  let lastText = '';
  let lastError = '';
  const flush = (): PanelStreamEvent[] => {
    const text = pending.trim();
    pending = '';
    if (!text) return [];
    lastText = text;
    return [{ type: 'assistant', message: { content: [{ type: 'text', text }] } }];
  };
  return (line) => {
    if (line.type === 'message' && line.role === 'assistant' && typeof line.content === 'string') {
      pending += line.content;
      return [];
    }
    if (line.type === 'tool_use') {
      return [
        ...flush(),
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: line.tool_id, name: claudeToolName(line.tool_name ?? '') },
            ],
          },
        },
      ];
    }
    if (line.type === 'tool_result') {
      const failed = line.status !== 'success';
      const output = typeof line.output === 'string' ? line.output : '';
      return [
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: line.tool_id,
                is_error: failed,
                content: failed ? line.error?.message || output : output,
              },
            ],
          },
        },
      ];
    }
    if (line.type === 'error' && line.message) {
      lastError = line.message;
      return [];
    }
    if (line.type === 'result') {
      const events = flush();
      if (line.status === 'success') return [...events, { type: 'result', result: lastText }];
      return [
        ...events,
        { type: 'result', result: line.error?.message || lastError, is_error: true },
      ];
    }
    return [];
  };
}
