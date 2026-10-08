import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { PANEL_AGENT_BRIDGE_ID, type PanelAgentMessage } from '@agentdeck/contracts/panel-agent';
import { kimiCodeHome } from '../../../providers/catalog/config-dirs.ts';
import {
  PANEL_AGENT_TOOL_PREFIX,
  type BridgeLaunch,
  type PanelStreamEvent,
} from '../foreign-cli/foreign-cli.ts';

/**
 * Агент панели у Kimi Code 2.1 — то же обещание лёгкого окна, что у Claude.
 *
 * Слои Kimi лежат в одном каталоге `KIMI_CODE_HOME` (`~/.kimi-code`): `config.toml`
 * (модели, права, `[[hooks]]`), `mcp.json`, `AGENTS.md`, скиллы, сессии. У хода
 * свой каталог в папке хода; из конфига человека переносятся только разделы
 * модели, вход по логину — ссылкой на его `credentials/`. Файл агента
 * (`--agent-file`) оставляет модели только инструменты переходника — без `Skill`
 * Kimi не показывает модели и скиллы (свои, `~/.agents/skills`, проектные), а тело
 * файла без `${base_prompt}` — промпт целиком наш, без AGENTS.md проекта. Снято
 * на настоящем kimi с заглушкой модели (`.agent/provider-formats.agent.md` §kimi
 * panel agent).
 */

/** Разделы `config.toml` человека, которые нужны модели: провайдер, модель и их настройки. */
export const KIMI_MODEL_KEYS: readonly string[] = [
  'default_model',
  'default_provider',
  'providers',
  'models',
  'thinking',
  'secondary_model',
  'model_catalog',
  'image',
  'loop_control',
];

/**
 * Потолок реплики в argv: промпт Kimi берёт только флагом `-p` (stdin не
 * читает), а командная строка Windows — до 32 767 знаков вместе с путями.
 */
export const KIMI_REQUEST_MAX_CHARS = 24_000;

/**
 * Тело файла агента — шаблон: `${имя}` известной переменной Kimi подменяет сам
 * (`${agents_md}` — это AGENTS.md проекта). Знак U+2060 между `$` и `{` ломает
 * подстановку, а в тексте не виден.
 */
export function kimiPromptLiteral(text: string): string {
  return text.replace(/\$\{(?=[A-Za-z_][A-Za-z0-9_]*\})/g, '$\u2060{');
}

/**
 * Разговор для Kimi: последняя реплика — флагом `-p`, прежние реплики и итоги
 * действий — в файл агента, тем же текстом, что stdin у остальных CLI.
 */
export function kimiConversation(
  messages: PanelAgentMessage[],
  actions: string[] = [],
): { request: string; context: string } {
  const memory =
    actions.length > 0
      ? `Panel actions already done in this conversation (oldest first; state may have changed since):\n${actions.map((note) => `- ${note}`).join('\n')}`
      : '';
  const history = messages
    .slice(0, -1)
    .map((message) => `${message.role === 'user' ? 'Human' : 'Assistant'}: ${message.content}`)
    .join('\n\n');
  const context = [memory, history ? `Conversation so far:\n\n${history}` : '']
    .filter(Boolean)
    .join('\n\n');
  return { request: messages[messages.length - 1]?.content ?? '', context };
}

/** Из конфига человека — только разделы модели; файл не TOML или его нет — модель из окружения. */
function userModelConfig(userHome: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(join(userHome, 'config.toml'), 'utf8'));
  } catch {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const key of KIMI_MODEL_KEYS) if (parsed[key] !== undefined) out[key] = parsed[key];
  return out;
}

/** Файл агента: только инструменты переходника, промпт — наш дословно. */
export function kimiAgentFile(systemPromptText: string, context: string): string {
  return [
    '---',
    `name: ${PANEL_AGENT_BRIDGE_ID}`,
    'description: AgentDeck panel agent; acts only through the panel bridge.',
    'tools:',
    `  - "${PANEL_AGENT_TOOL_PREFIX}*"`,
    '---',
    '',
    kimiPromptLiteral(systemPromptText),
    ...(context ? ['', kimiPromptLiteral(context)] : []),
    '',
  ].join('\n');
}

/**
 * Каталог хода в папке хода `dir`; возвращает файлы для argv и добавку к
 * окружению. Вход по логину — ссылкой (junction) на `credentials/` человека:
 * Kimi обновляет токен на месте, и копия разошлась бы с файлом человека.
 * Удаление папки хода снимает ссылку, а не каталог за ней.
 */
export function prepareKimiAgentHome(options: {
  dir: string;
  bridge: BridgeLaunch;
  systemPromptText: string;
  context: string;
  userHome?: string;
  toolTimeoutMs: number;
}): { env: Record<string, string>; agentFile: string } {
  const userHome = options.userHome ?? kimiCodeHome();
  const home = join(options.dir, 'kimi-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), stringifyToml(userModelConfig(userHome)), 'utf8');
  writeFileSync(
    join(home, 'mcp.json'),
    JSON.stringify({ mcpServers: { [PANEL_AGENT_BRIDGE_ID]: options.bridge } }),
    'utf8',
  );
  const credentials = join(userHome, 'credentials');
  if (existsSync(credentials)) {
    try {
      symlinkSync(credentials, join(home, 'credentials'), 'junction');
    } catch {
      cpSync(credentials, join(home, 'credentials'), { recursive: true });
    }
  }
  const agentFile = join(options.dir, 'kimi-agent.md');
  writeFileSync(agentFile, kimiAgentFile(options.systemPromptText, options.context), 'utf8');
  return {
    agentFile,
    env: {
      KIMI_CODE_HOME: home,
      // Вызов ждёт клика человека по карточке — дольше стандартного ожидания CLI.
      KIMI_MCP_TOOL_TIMEOUT_MS: String(options.toolTimeoutMs),
      KIMI_DISABLE_TELEMETRY: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    },
  };
}

/**
 * Argv хода: `-p` — одиночный запуск, вызовы MCP в нём идут без вопроса CLI
 * (`--auto` с `-p` Kimi отвергает).
 */
export function kimiPanelAgentArgs(files: { request: string; agentFile: string }): string[] {
  return ['-p', files.request, '--output-format', 'stream-json', '--agent-file', files.agentFile];
}

interface KimiToolCall {
  id?: string;
  function?: { name?: string };
}

interface KimiLine {
  role?: string;
  type?: string;
  content?: unknown;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
}

/** Отказ вызова на стороне CLI (таймаут, упавший сервер) — единственный признак ошибки в потоке. */
const KIMI_TOOL_FAILED = /^Tool "[^"]*" failed: /;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

/**
 * Перевод `kimi -p --output-format stream-json` в события Claude. Kimi 2.1:
 * `{"role":"assistant","content"?,"tool_calls"?}`, `{"role":"tool",
 * "tool_call_id","content"}`, служебные `{"role":"meta",…}`; конец удачного
 * хода — `meta` `session.resume_hint`, сбой — код выхода и причина в stderr.
 * Отказ переходника (`isError`) поток не помечает — его видит только модель;
 * помечен лишь отказ самого CLI (`Tool "x" failed: …`).
 */
export function createKimiTranslator(): (line: KimiLine) => PanelStreamEvent[] {
  let lastText = '';
  return (line) => {
    if (line.role === 'assistant') {
      const events: PanelStreamEvent[] = [];
      const text = typeof line.content === 'string' ? line.content.trim() : '';
      if (text) {
        lastText = text;
        events.push({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
      }
      for (const call of line.tool_calls ?? []) {
        events.push({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: call.id, name: call.function?.name ?? '' }],
          },
        });
      }
      return events;
    }
    if (line.role === 'tool') {
      const content = asText(line.content);
      return [
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: line.tool_call_id,
                is_error: KIMI_TOOL_FAILED.test(content),
                content,
              },
            ],
          },
        },
      ];
    }
    if (line.role === 'meta' && line.type === 'session.resume_hint') {
      return [{ type: 'result', result: lastText }];
    }
    return [];
  };
}
