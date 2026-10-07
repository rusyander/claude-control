import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PANEL_AGENT_BRIDGE_ID } from '@agentdeck/contracts/panel-agent';
import { gooseConfigDir } from '../../providers/catalog/config-dirs.ts';
import {
  PANEL_AGENT_TOOL_PREFIX,
  type BridgeLaunch,
  type PanelStreamEvent,
} from './foreign-cli.ts';

/**
 * Агент панели у Goose 1.53 — то же обещание лёгкого окна, что у Claude.
 *
 * Слои Goose — `config.yaml` (провайдер, режим, расширения), подсказки
 * `.goosehints`/`AGENTS.md` (глобальные в каталоге конфига и проектные), скиллы
 * `~/.agents/skills` и платформенные расширения (todo, apps, delegate,
 * extensionmanager, load_skill и др. — включены по умолчанию). У хода свой
 * `GOOSE_PATH_ROOT` в папке хода (конфиг, данные с сессиями, логи), `--no-profile`
 * снимает расширения человека и платформенные, переходник приходит флагом
 * `--with-extension`, подсказки сняты `CONTEXT_FILE_NAMES`, промпт — файлом
 * `GOOSE_SYSTEM_PROMPT_FILE_PATH` вместо промпта Goose. Снято на настоящем goose
 * с заглушкой модели (`.agent/provider-formats.agent.md` §goose panel agent): без
 * этого модели уходят подсказки человека и проекта, AGENTS.md, проектный скилл,
 * его MCP-сервер и 17 встроенных инструментов, а `smart_approve` человека
 * роняет ход без терминала.
 */

/** Файл промпта Goose — шаблон minijinja: битый шаблон Goose молча меняет на свой промпт. */
export function gooseSystemPromptFile(text: string): string {
  const safe = text.replace(/\{%-?\s*endraw\s*-?%\}/g, '{ % endraw % }');
  return `{% raw %}${safe}{% endraw %}`;
}

/** Ключи, которые ход задаёт сам: ход без терминала и без лишнего. */
const OWN_KEYS = new Set(['GOOSE_MODE', 'extensions']);

/**
 * Из конфига человека — только скаляры верхнего уровня: провайдер, модель,
 * адреса и настройки провайдера. Карты и списки (расширения, плагины и прочее
 * своё) не переносятся. Файл не YAML или его нет — ход идёт на окружении.
 */
function userScalars(configDir: string): Record<string, string | number | boolean> {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(join(configDir, 'config.yaml'), 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (OWN_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Переменные провайдера человека: Goose читает настройку провайдера и из
 * окружения (`OPENAI_API_KEY`, `OLLAMA_HOST`…) — проходят только те, что
 * начинаются с имени его провайдера. Это ключ, которым человек сам запускает
 * Goose, а не ключ панели.
 */
function providerEnv(provider: unknown, env: NodeJS.ProcessEnv): Record<string, string> {
  if (typeof provider !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(provider)) return {};
  const prefix = `${provider.replace(/-/g, '_').toUpperCase()}_`;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.toUpperCase().startsWith(prefix)) out[name] = value;
  }
  return out;
}

/**
 * Корень хода в папке хода `dir`; возвращает добавку к окружению процесса.
 * Секреты человека — копией `secrets.yaml` (когда он без связки ключей) и его
 * `custom_providers`; связка ключей ОС от каталога не зависит.
 */
export function prepareGooseAgentRoot(options: {
  dir: string;
  systemPromptText: string;
  userConfigDir?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = options.env ?? process.env;
  const userDir = options.userConfigDir ?? gooseConfigDir();
  const root = join(options.dir, 'goose-root');
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  const scalars = userScalars(userDir);
  writeFileSync(
    join(configDir, 'config.yaml'),
    // Подтверждение живёт в карточке панели; `approve`/`smart_approve` без
    // терминала Goose отклоняет как неверную настройку.
    stringifyYaml({ ...scalars, GOOSE_MODE: 'auto', extensions: {} }),
    'utf8',
  );
  const secrets = join(userDir, 'secrets.yaml');
  if (existsSync(secrets)) copyFileSync(secrets, join(configDir, 'secrets.yaml'));
  const customProviders = join(userDir, 'custom_providers');
  if (existsSync(customProviders)) {
    cpSync(customProviders, join(configDir, 'custom_providers'), { recursive: true });
  }
  const promptFile = join(options.dir, 'agent-system.md');
  writeFileSync(promptFile, gooseSystemPromptFile(options.systemPromptText), 'utf8');
  return {
    ...providerEnv(env.GOOSE_PROVIDER ?? scalars.GOOSE_PROVIDER, env),
    GOOSE_PATH_ROOT: root,
    GOOSE_SYSTEM_PROMPT_FILE_PATH: promptFile,
    GOOSE_MODE: 'auto',
    // Имя, которого нет ни в одном проекте: подсказки и AGENTS.md не читаются.
    CONTEXT_FILE_NAMES: '[".agentdeck-panel-no-hints"]',
    GOOSE_TELEMETRY_OFF: '1',
  };
}

/**
 * Переходник флагом: `имя:ПЕРЕМЕННАЯ=значение … команда аргументы`. Каждое слово
 * в кавычках — путь к node с пробелом («Program Files») иначе разваливается.
 * Ожидание вызова у такого расширения — 300 с (по умолчанию Goose, флаг своего
 * срока не принимает): `PANEL_AGENT_FIXED_TOOL_TIMEOUT_MS.goose`, и срок карточки
 * хода Goose берётся оттуда (`panelAgentConfirmTimeoutMs`) — короче вызова.
 * Отмену вызова переходник всё равно доводит до панели (`tools/mcp/panel.mjs`).
 */
export function gooseExtensionSpec(bridge: BridgeLaunch): string {
  const quote = (word: string): string => JSON.stringify(word);
  const vars = Object.entries(bridge.env).map(([name, value]) => `${name}=${quote(value)}`);
  return `${PANEL_AGENT_BRIDGE_ID}:${[...vars, quote(bridge.command), ...bridge.args.map(quote)].join(' ')}`;
}

/** Argv хода: разговор — в stdin, без сессии Goose и без расширений человека. */
export function goosePanelAgentArgs(bridge: BridgeLaunch): string[] {
  return [
    'run',
    '--no-session',
    '--no-profile',
    '--output-format',
    'stream-json',
    '-i',
    '-',
    '--with-extension',
    gooseExtensionSpec(bridge),
  ];
}

const GOOSE_BRIDGE_PREFIX = `${PANEL_AGENT_BRIDGE_ID}__`;

function claudeToolName(name: string): string {
  return name.startsWith(GOOSE_BRIDGE_PREFIX)
    ? `${PANEL_AGENT_TOOL_PREFIX}${name.slice(GOOSE_BRIDGE_PREFIX.length)}`
    : name;
}

interface GooseContent {
  type?: string;
  text?: string;
  id?: string;
  message?: string;
  toolCall?: { status?: string; value?: { name?: string }; error?: unknown };
  toolResult?: {
    status?: string;
    value?: { content?: unknown; isError?: boolean };
    error?: unknown;
  };
}

interface GooseLine {
  type?: string;
  message?: { role?: string; content?: GooseContent[] };
  error?: unknown;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

/**
 * Перевод `goose run --output-format stream-json` в события Claude. Goose 1.53:
 * `message` с `role` и списком `content` — `text` (ответ приходит кусками,
 * каждый отдельной строкой), `toolRequest` (`toolCall.value.name`),
 * `toolResponse` (`toolResult.status` + `value.content`) и `error`; конец хода —
 * `complete`, сбой — `{"type":"error","error":"…"}`. Итога хода CLI не шлёт —
 * он собирается из последнего текста, как `result` у Claude.
 */
export function createGooseTranslator(): (line: GooseLine) => PanelStreamEvent[] {
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
    if (line.type === 'message') {
      const events: PanelStreamEvent[] = [];
      for (const item of line.message?.content ?? []) {
        if (item.type === 'text' && line.message?.role === 'assistant') {
          pending += item.text ?? '';
        } else if (item.type === 'toolRequest') {
          events.push(...flush(), {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: item.id,
                  name: claudeToolName(item.toolCall?.value?.name ?? ''),
                },
              ],
            },
          });
        } else if (item.type === 'toolResponse') {
          const result = item.toolResult;
          const failed = result?.status !== 'success' || result.value?.isError === true;
          events.push({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: item.id,
                  is_error: failed,
                  content:
                    result?.status === 'success'
                      ? asText(result.value?.content)
                      : asText(result?.error),
                },
              ],
            },
          });
        } else if (item.type === 'error' && item.message) {
          lastError = item.message;
        }
      }
      return events;
    }
    if (line.type === 'complete') return [...flush(), { type: 'result', result: lastText }];
    if (line.type === 'error') {
      return [
        ...flush(),
        {
          type: 'result',
          result: asText(line.error ?? lastError) || 'Goose error',
          is_error: true,
        },
      ];
    }
    return [];
  };
}
