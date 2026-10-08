import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PANEL_AGENT_BRIDGE_ID,
  PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
} from '@agentdeck/contracts/panel-agent';
import { parseProviderJsonObject } from '../../../lib/provider-json.ts';
import { opencodeConfigDir } from '../../../providers/catalog/config-dirs.ts';
import {
  PANEL_AGENT_TOOL_PREFIX,
  type BridgeLaunch,
  type PanelStreamEvent,
} from '../foreign-cli/foreign-cli.ts';

/**
 * Агент панели у OpenCode 1.18 — то же обещание лёгкого окна, что у Claude.
 *
 * Слои OpenCode — каталоги XDG (конфиг, AGENTS.md, скиллы, агенты, данные с
 * сессиями) плюс проектный `opencode.json`/AGENTS.md и `~/.claude/CLAUDE.md`. У
 * хода свои `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME` во временной папке
 * хода, проектный слой и слой Claude сняты переменными CLI, внешние плагины —
 * `--pure`. В конфиге хода — только провайдеры и модель человека, переходник и
 * агент `agentdeck-panel`, у которого из инструментов только переходник. Снято
 * на настоящем opencode с заглушкой модели (`.agent/provider-formats.agent.md`
 * §opencode panel agent): без этого модели уходят AGENTS.md человека и проекта,
 * его скилл, его MCP-сервер и 11 встроенных инструментов.
 */

export const OPENCODE_AGENT_NAME = PANEL_AGENT_BRIDGE_ID;

/** Ключи конфига человека, без которых ход остался бы без его модели и входа. */
const USER_CONFIG_KEYS = [
  'provider',
  'model',
  'small_model',
  'enabled_providers',
  'disabled_providers',
] as const;

/** Каталог данных OpenCode человека (там `auth.json`): `$XDG_DATA_HOME/opencode`. */
export function userOpencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.XDG_DATA_HOME?.trim();
  return join(raw ? resolve(raw) : join(homedir(), '.local', 'share'), 'opencode');
}

/**
 * Провайдеры и модель из конфигов человека — в том порядке, в каком OpenCode их
 * сливает: `config.json` < `opencode.json` < `opencode.jsonc` < `OPENCODE_CONFIG`.
 * Файл с комментариями не разбирается и пропускается: тогда ход идёт на модели
 * по умолчанию, а не падает.
 */
function userProvidersAndModel(configDir: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) =>
    join(configDir, name),
  );
  const custom = env.OPENCODE_CONFIG?.trim();
  if (custom) files.push(resolve(custom));
  const out: Record<string, unknown> = {};
  for (const file of files) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseProviderJsonObject<Record<string, unknown>>(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const key of USER_CONFIG_KEYS) if (parsed[key] !== undefined) out[key] = parsed[key];
  }
  return out;
}

/** Конфиг хода: провайдеры человека, переходник и агент только с переходником. */
export function opencodeAgentConfig(
  bridge: BridgeLaunch,
  systemPromptText: string,
  user: Record<string, unknown>,
): Record<string, unknown> {
  const bridgeTools = `${PANEL_AGENT_BRIDGE_ID}_*`;
  return {
    $schema: 'https://opencode.ai/config.json',
    ...user,
    mcp: {
      [PANEL_AGENT_BRIDGE_ID]: {
        type: 'local',
        command: [bridge.command, ...bridge.args],
        environment: bridge.env,
        enabled: true,
        // Вызов ждёт клика человека по карточке — дольше стандартного ожидания CLI.
        timeout: PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
      },
    },
    agent: {
      [OPENCODE_AGENT_NAME]: {
        mode: 'primary',
        prompt: systemPromptText,
        tools: { '*': false, [bridgeTools]: true },
        // Подтверждение живёт в карточке панели, не в CLI.
        permission: { '*': 'deny', [bridgeTools]: 'allow' },
      },
      // Скрытый агент заголовка — лишний вызов модели человека на каждый ход.
      title: { disable: true },
    },
    share: 'disabled',
    autoupdate: false,
  };
}

/** Имена из `{env:ИМЯ}` в провайдерах человека — им нужно значение из окружения. */
function referencedEnv(value: unknown): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(value ?? null).matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

/**
 * Слои хода в папке хода `dir`; возвращает добавку к окружению процесса.
 * Вход человека — копией `auth.json` (папка хода удаляется в конце хода) и
 * значениями переменных, на которые ссылаются его провайдеры (`{env:ИМЯ}`):
 * это ключи, которыми человек сам запускает OpenCode, а не ключ панели.
 */
export function prepareOpencodeAgentLayers(options: {
  dir: string;
  bridge: BridgeLaunch;
  systemPromptText: string;
  userConfigDir?: string;
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = options.env ?? process.env;
  const configHome = join(options.dir, 'xdg-config');
  const dataHome = join(options.dir, 'xdg-data');
  const stateHome = join(options.dir, 'xdg-state');
  mkdirSync(join(configHome, 'opencode'), { recursive: true });
  mkdirSync(join(dataHome, 'opencode'), { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  const user = userProvidersAndModel(options.userConfigDir ?? opencodeConfigDir(), env);
  writeFileSync(
    join(configHome, 'opencode', 'opencode.json'),
    JSON.stringify(opencodeAgentConfig(options.bridge, options.systemPromptText, user), null, 2),
    'utf8',
  );
  const auth = join(options.userDataDir ?? userOpencodeDataDir(env), 'auth.json');
  if (existsSync(auth)) copyFileSync(auth, join(dataHome, 'opencode', 'auth.json'));
  const extra: Record<string, string> = {};
  for (const name of referencedEnv(user.provider)) {
    const value = env[name];
    if (value !== undefined) extra[name] = value;
  }
  return {
    ...extra,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
  };
}

/**
 * Argv хода: разговор — в stdin; картинки — вложениями `-f` (их читает сам
 * OpenCode в сообщение, инструмента файлов у агента нет); `--pure` — без
 * внешних плагинов человека.
 */
export function opencodePanelAgentArgs(imagePaths: readonly string[] = []): string[] {
  return [
    'run',
    '--pure',
    '--format',
    'json',
    '--agent',
    OPENCODE_AGENT_NAME,
    ...imagePaths.flatMap((path) => ['-f', path]),
  ];
}

const OPENCODE_BRIDGE_PREFIX = `${PANEL_AGENT_BRIDGE_ID}_`;

/** Итог инструмента строкой: OpenCode кладёт туда и строку, и объект. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function claudeToolName(name: string): string {
  return name.startsWith(OPENCODE_BRIDGE_PREFIX)
    ? `${PANEL_AGENT_TOOL_PREFIX}${name.slice(OPENCODE_BRIDGE_PREFIX.length)}`
    : name;
}

interface OpencodeLine {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    reason?: string;
    state?: { status?: string; output?: unknown; error?: unknown };
  };
  error?: { name?: string; data?: { message?: string } };
}

/**
 * Перевод `opencode run --format json` в события Claude. OpenCode 1.18:
 * `text` (`part.text` — весь кусок), `tool_use` (`part.tool`, `part.callID`,
 * `part.state` уже с итогом: `completed` + `output` или `error`), `step_finish`
 * (`part.reason`: `tool-calls` — ход продолжается, `stop` — конец), `error`
 * (`error.data.message`). Итога хода CLI не шлёт — он собирается на `stop` из
 * последнего текста, как `result` у Claude.
 */
export function createOpencodeTranslator(): (line: OpencodeLine) => PanelStreamEvent[] {
  let lastText = '';
  return (line) => {
    const part = line.part;
    if (line.type === 'text' && part?.text) {
      lastText = part.text;
      return [{ type: 'assistant', message: { content: [{ type: 'text', text: part.text }] } }];
    }
    if (line.type === 'tool_use' && part?.tool) {
      const failed = part.state?.status !== 'completed';
      const output = part.state?.output;
      const error = part.state?.error;
      return [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: part.callID, name: claudeToolName(part.tool) }],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: part.callID,
                is_error: failed,
                content: asText(failed ? error : output),
              },
            ],
          },
        },
      ];
    }
    if (line.type === 'step_finish' && part?.reason === 'stop') {
      return [{ type: 'result', result: lastText }];
    }
    if (line.type === 'error') {
      return [
        {
          type: 'result',
          result: line.error?.data?.message || line.error?.name || 'OpenCode error',
          is_error: true,
        },
      ];
    }
    return [];
  };
}
