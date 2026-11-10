import { join } from 'node:path';
import { codexRunFacts } from '@agentdeck/providers/codex';
import { tierLadderOf } from '@agentdeck/providers/ladder';
import { currentOs, homeDir } from '../../platform/os-kind.ts';
import type {
  AdapterCaps,
  AdapterChannelSummary,
  BindOutcome,
  BoundEndpoint,
  EndpointBinding,
  LayerRun,
  ReadLayer,
  SessionSpec,
} from '../adapter.types.ts';
import { bareHookWords, HOOK_JSON_FLAG } from '../hook-words.ts';
import { splitCarried } from '../mcp-carry.ts';
import { codexEconomy } from '../economy-carry.ts';
import { codexMcpSource } from './mcp-source.ts';
import { READ_ONLY_DENIED } from '../read-only.ts';
import {
  createRpcAdapter,
  type RpcAdapter,
  type RpcAdapterOptions,
} from '../rpc-stdio/rpc-adapter.ts';
import type { SdkLaunchPlan } from '../sdk-stream/sdk-adapter.ts';
import { createCodexDialect, type CodexDialectData } from './app-server.ts';
import { CODEX_PERMIT_CODEC, mapCodexPermission } from './permission.ts';
import {
  CODEX_HOME_DIR,
  codexOwnsTranscript,
  codexResume,
  codexTranscriptPresent,
} from './transcript.ts';

/**
 * Переходник Codex (codex-cli 0.155.1) поверх `codex app-server` — JSON-RPC по stdio. Дом
 * конфигурации у каждого сеанса свой (`CODEX_HOME` = `<сеанс>/codex-home`): адрес модели,
 * хук ядра, правила запуска. Конфиг, вход и хуки человека сеанс не читает никогда.
 *
 * Возможности — только доказанные пробой 02.11 на stub-model: хук `PreToolUse` (после доверия
 * через `hooks/list` + `config/batchWrite`), эхо отправки (`clientUserMessageId` → `clientId`),
 * поток текста, продолжение нити (`thread/resume` по файлу разговора, скопированному в дом сеанса —
 * `transcript.ts`), серверы MCP шага (`[mcp_servers]` дома сеанса; серверы человека и
 * репозитория не стартуют — s10 p6). Картинок, подагентов и управления слоем нет: непроверенное
 * объявлять нельзя (P121).
 */

const HOME = CODEX_HOME_DIR;
const KEY_VAR = 'AGENTDECK_CODEX_KEY';
const PROVIDER = 'agentdeck';
/** Хук ядра ждёт ответа до 50 с (`mcp/hook.ts`); Codex по умолчанию снимает хук через 30 с. */
const HOOK_TIMEOUT_S = 60;

export const CODEX_FILES = {
  config: `${HOME}/config.toml`,
  hooks: `${HOME}/hooks.json`,
  rules: `${HOME}/rules/default.rules`,
} as const;

export const CODEX_CHANNELS: AdapterChannelSummary[] = [
  // Адрес — таблицей `model_providers` в config.toml дома сеанса: файл свой у каждого сеанса.
  { via: 'file', dialect: 'openai-responses', keyVar: KEY_VAR, perSession: true },
];

export const CODEX_CAPS: AdapterCaps = {
  resume: true,
  mcp: true,
  strictMcp: true,
  permissionTool: false,
  // Правила запуска (`rules/*.rules`) — только префиксы команд: путей запрета ими не выразить,
  // оверлея нет. Они пишутся вторым замком против публикации (P81), если хук ядра упал.
  denyOverlay: false,
  preToolHooks: true,
  layerControl: false,
  attribution: true,
  stream: true,
  effort: false,
  images: false,
  subagents: false,
  skillControl: false,
  subagentHooks: false,
  login: codexRunFacts.login,
  channels: CODEX_CHANNELS,
  windowEvent: false,
  limitsChannel: null,
  // Потерю входа (этап 12, P170) не называет: текста и чтения входа в наборе соответствия нет.
  loginLost: false,
};

const toml = (value: string): string => JSON.stringify(value);

export function bindCodexEndpoint(
  channel: AdapterChannelSummary,
  endpoint: BoundEndpoint,
): BindOutcome {
  if (channel.dialect !== 'openai-responses' || endpoint.dialect !== 'openai-responses') {
    return { ok: false, code: 'no_channel' };
  }
  const base = `${endpoint.baseUrl.replace(/\/+$/, '')}/v1`;
  const config = [
    `model = ${toml(endpoint.model)}`,
    `model_provider = ${toml(PROVIDER)}`,
    'check_for_update_on_startup = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    'plugins = false',
    'apps = false',
    '',
    `[model_providers.${PROVIDER}]`,
    `name = ${toml(PROVIDER)}`,
    `base_url = ${toml(base)}`,
    'wire_api = "responses"',
    `env_key = ${toml(KEY_VAR)}`,
    '',
  ].join('\n');
  const binding: EndpointBinding = {
    env: { [KEY_VAR]: endpoint.key },
    argv: [],
    files: { [CODEX_FILES.config]: config },
  };
  return { ok: true, binding };
}

/** Каталоги Codex человека вне копии: вход (`auth.json`) судья не даёт читать. */
export function codexReadLayer(pin: Record<string, string>): ReadLayer {
  const home = pin.CODEX_HOME || join(homeDir(pin), '.codex');
  return {
    dirs: [],
    credentials: [join(home, 'auth.json'), join(home, 'config.toml')],
  };
}

/** Слой человека не грузится никогда: дом конфигурации — свой у сеанса (потеря названа). */
export function codexLayer(spec: SessionSpec): LayerRun {
  const asked = spec.layer.hooks;
  return {
    asked,
    ran: 'off',
    repoLayer: false,
    trust: 'none',
    detail: 'codex: per-session CODEX_HOME, the human and repo hooks do not load',
    ...(asked === 'off' ? {} : { losses: [`hooks ${asked} -> off: codex has no layer control`] }),
  };
}

/**
 * Команда в `hooks.json`: слова хука ядра без кавычек (Codex исполняет её без оболочки-посредника
 * кавычек) и `--json` — отказ JSON-ом при коде 0. Код 2 Codex на Windows теряет («exited with
 * code 1») и вызов исполняет; JSON `permissionDecision: "deny"` он держит как запрет (проба 02.11).
 * POSIX: хук ядра — файл `<сеанс>/core-hook`, слово `--json` он передаёт через `"$@"`.
 */
export function codexHookCommand(spec: SessionSpec): string | null {
  const words = spec.coreHook ? bareHookWords(spec.coreHook) : null;
  if (!words) return null;
  return [...words, HOOK_JSON_FLAG].join(' ');
}

const readOnly = (spec: SessionSpec): boolean =>
  READ_ONLY_DENIED.every((tool) => spec.deny.tools.includes(tool));

/** Правила запуска: каждая запрещённая команда — префикс `forbidden` (второй замок P81). */
export function codexRules(spec: SessionSpec): string {
  return spec.deny.commands
    .filter((argv) => argv.length > 0)
    .map(
      (argv) =>
        `prefix_rule(pattern=[${argv.map((a) => JSON.stringify(a)).join(', ')}], decision="forbidden", justification="agentdeck: refused by the platform")`,
    )
    .join('\n')
    .concat('\n');
}

export function refuseCodex(spec: SessionSpec): string | null {
  if (!spec.coreHook) {
    return 'no core hook: the session would run without the core PreToolUse hook';
  }
  if (!codexHookCommand(spec)) {
    return 'core hook command has whitespace or a shell metacharacter; codex cannot run it unquoted';
  }
  if (!spec.endpoint) {
    // Свой вход Codex живёт в доме человека: сеанс его не читает, а копия auth.json обновляла бы
    // токен человека из чужого процесса.
    return 'codex runs only on a routed endpoint: its own login lives in the human CODEX_HOME';
  }
  return null;
}

/**
 * Серверы MCP шага — таблицами `[mcp_servers.<имя>]` config.toml дома сеанса (`command`, `args`,
 * `env`): дом свой у сеанса, иных серверов Codex не видит. Ключ имени — строкой TOML (имена с `-`).
 */
export function codexMcpToml(spec: SessionSpec): string {
  const { stdio, remote } = splitCarried(spec, CODEX_REMOTE_MCP, '');
  const table = (record: Record<string, string> | undefined): string =>
    `{ ${Object.entries(record ?? {})
      .map(([key, value]) => `${toml(key)} = ${toml(value)}`)
      .join(', ')} }`;
  const filled = (record: Record<string, string> | undefined): boolean =>
    !!record && Object.keys(record).length > 0;
  return [
    ...stdio.map(([name, entry]) =>
      [
        `[mcp_servers.${toml(name)}]`,
        `command = ${toml(entry.command)}`,
        `args = [${entry.args.map(toml).join(', ')}]`,
        ...(filled(entry.env) ? [`env = ${table(entry.env)}`] : []),
        ...(entry.cwd ? [`cwd = ${toml(entry.cwd)}`] : []),
        '',
      ].join('\n'),
    ),
    // Удалённый — streamable HTTP: `url` + `http_headers` (значения уже подставлены ядром).
    ...remote.map(([name, entry]) =>
      [
        `[mcp_servers.${toml(name)}]`,
        `url = ${toml(entry.url)}`,
        ...(filled(entry.headers) ? [`http_headers = ${table(entry.headers)}`] : []),
        '',
      ].join('\n'),
    ),
  ].join('\n');
}

/**
 * Удалённые серверы MCP (s10 p8): Codex 0.155.1 несёт streamable HTTP (`url`, `http_headers`,
 * `env_http_headers`, `bearer_token_env_var` — строки сборки) и отказывает SSE («SSE transport is not
 * supported»): SSE — потеря с именем.
 */
export const CODEX_REMOTE_MCP = { http: true, sse: false } as const;

/**
 * Флаги `[features]`, которые снимает сеанс без инструментов (`tools: 'none'`, вопрос «ask», s10
 * p10). Проба Codex 0.155.1 (02.11): запрос модели по умолчанию несёт `exec_command`, `write_stdin`,
 * `request_user_input`, `view_image`, `multi_agent_v1`, `*_goal`, `web_search`; с этими флагами,
 * `web_search = "disabled"` и `[tools.experimental_request_user_input] enabled = false` — ни одного.
 * Прочие флаги — встроенные, которые Codex подключает при иных условиях (вход OpenAI, плагины).
 */
export const CODEX_NONE_FEATURES = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'multi_agent',
  'goals',
  'sleep_tool',
  'tool_suggest',
  'skill_search',
  'browser_use',
  'computer_use',
  'image_generation',
  'code_mode_host',
] as const;

const FEATURES_TABLE = '[features]';

/**
 * config.toml сеанса без встроенных инструментов: ключ верхнего уровня — до первой таблицы, флаги —
 * в таблицу `[features]` привязки (вторая таблица того же имени TOML запрещает), вопрос человеку —
 * своей таблицей в конце. Серверы MCP шага остаются: они — инструменты шага, не встроенные.
 */
export function codexToolsNone(config: string): string {
  const flags = CODEX_NONE_FEATURES.map((name) => `${name} = false`).join('\n');
  const at = config.split('\n').indexOf(FEATURES_TABLE);
  const lines = config.split('\n');
  const withFlags =
    at >= 0
      ? [...lines.slice(0, at + 1), flags, ...lines.slice(at + 1)].join('\n')
      : `${config}\n${FEATURES_TABLE}\n${flags}\n`;
  return `web_search = "disabled"\n${withFlags}\n[tools.experimental_request_user_input]\nenabled = false\n`;
}

export function planCodex(
  spec: SessionSpec,
  binding: EndpointBinding | null,
  _layer: LayerRun,
): SdkLaunchPlan {
  const hook = codexHookCommand(spec) as string;
  const mcp = codexMcpToml(spec);
  const economy = codexEconomy(spec);
  const lost = [
    ...splitCarried(spec, CODEX_REMOTE_MCP, 'codex carries streamable http only').lost,
    ...economy.lost,
  ];
  // Файл плана перебивает файл привязки того же пути: адрес и MCP — в одном config.toml.
  const config = binding?.files[CODEX_FILES.config];
  const none = spec.tools === 'none';
  // Рычаги экономии — ключи верхнего уровня: в TOML они обязаны стоять до первой таблицы.
  const assembled = `${economy.toml ? `${economy.toml}\n` : ''}${config ?? ''}\n${mcp}`;
  return {
    args: ['app-server'],
    env: { CODEX_HOME: join(spec.dir, HOME) },
    files: {
      ...(mcp || economy.toml || none
        ? { [CODEX_FILES.config]: none ? codexToolsNone(assembled) : assembled }
        : {}),
      [CODEX_FILES.hooks]: JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: hook, timeout: HOOK_TIMEOUT_S }],
              },
            ],
          },
        },
        null,
        2,
      ),
      [CODEX_FILES.rules]: codexRules(spec),
    },
    ...(lost.length > 0 ? { layerLosses: lost } : {}),
  };
}

export function createCodexAdapter(options: RpcAdapterOptions = {}): RpcAdapter {
  const ladder = tierLadderOf(codexRunFacts);
  return createRpcAdapter(
    {
      id: codexRunFacts.id,
      caps: CODEX_CAPS,
      command: codexRunFacts.binary.command,
      ...(ladder ? { ladder } : {}),
      // Вход Codex — в CODEX_HOME человека, сеанс его не читает: маршрута входа CLI нет.
      cliLogin: false,
      readLayer: codexReadLayer,
      mcpSource: codexMcpSource,
      bindEndpoint: bindCodexEndpoint,
      layer: codexLayer,
      refuse: refuseCodex,
      plan: planCodex,
      resume: codexResume,
      ownsTranscript: codexOwnsTranscript,
      transcriptPresent: codexTranscriptPresent,
      toolsNone: true,
      ephemeral: 'flag',
      dialectInput: ({ spec, permit }): CodexDialectData => {
        const ro = readOnly(spec);
        return {
          cwd: spec.cwd,
          hookCommand: codexHookCommand(spec) as string,
          // Только чтение: без вопросов и в песочнице чтения. Иначе каждый вызов вне
          // «безопасных» Codex спрашивает, ответ — у судьи ядра. Песочница записи на Windows
          // отказывает всё (проба 02.11), там — чтение и вопрос на каждую запись.
          approvalPolicy: ro ? 'never' : 'untrusted',
          sandbox: ro || currentOs() === 'win32' ? 'read-only' : 'workspace-write',
          developerInstructions: spec.brief,
          ...(spec.endpoint ? { model: spec.endpoint.endpoint.model } : {}),
          ...(spec.resume ? { resume: spec.resume.conversationId } : {}),
          ...(spec.ephemeral ? { ephemeral: true as const } : {}),
          permit,
        };
      },
      dialect: (data) => createCodexDialect({ ...data, mapPermission: mapCodexPermission }),
      // Бриф уходит только в строку `thread/start`, разбор его не читает: на диск — без него.
      viewInput: (data) => ({ ...data, developerInstructions: '' }),
      mapPermission: mapCodexPermission,
      permitCodec: CODEX_PERMIT_CODEC,
    },
    options,
  );
}
