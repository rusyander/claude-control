import { join } from 'node:path';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { envVarsChannels } from '@agentdeck/providers/channels';
import {
  type AdapterCaps,
  type AdapterChannelSummary,
  type BindOutcome,
  type BoundEndpoint,
  type EndpointBinding,
  type LayerRun,
  type LocalLimits,
  type SessionSpec,
} from '../adapter.types.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { READ_ONLY_DENIED } from '../read-only.ts';
import { trustedLayer, type LayerPolicy } from '../sdk-stream/layer-run.ts';
import { repoDenyDetail, repoDenyRefusal } from '../sdk-stream/repo-deny.ts';
import {
  createSdkAdapter,
  type SdkAdapter,
  type SdkAdapterOptions,
  type SdkLaunchPlan,
} from '../sdk-stream/sdk-adapter.ts';
import { mapQwenPermission, qwenDenyRules } from './permission.ts';
import { qwenSessionId } from './session-id.ts';
import { qwenReadLayer } from './read-layer.ts';
import { qwenRepoDeny } from './repo-deny.ts';
import {
  QWEN_DEFAULT_EXCLUDED_ENV,
  qwenRepoLayer,
  qwenRepoLayerDetail,
  qwenRepoLayerRefusal,
  type QwenRepoLayer,
} from './repo-layer.ts';
import { qwenTrustMark } from './trust.ts';

/**
 * Переходник Qwen Code. Говорит тем же `stream-json` формата SDK, что и Claude Code, но:
 * - эха нашей отправки нет — ход привязывается по очереди (`echo: false`, насос шлёт по одной);
 * - о праве спрашивает строкой протокола (`control_request can_use_tool`), а не инструментом;
 * - запреты, хук ядра, серверы MCP и пределы модели — в файле СИСТЕМНЫХ настроек сеанса
 *   (`QWEN_CODE_SYSTEM_SETTINGS_PATH`, старший слой CLI), файлы человека не трогаются;
 * - слой человека не отключается ничем, кроме подмены дома CLI, — `layerControl` не объявлен.
 */

const FILES = {
  system: 'qwen/system-settings.json',
} as const;

/**
 * Недоверенная копия (F-86). `observe` у Qwen нет (`layerControl` не объявлен). Безопасный режим
 * самого CLI (`folderTrust` + `DO_NOT_TRUST`) не годится: в недоверенной папке 0.24.3 не запускает
 * НИ ОДНОГО сервера MCP, сервер ядра тоже (F-89, H2), — шаг без `step_done`. Сеанс идёт с
 * `folderTrust` выключенным, а слой копии ядро разбирает само (`repo-layer.ts`): ключи, чьё
 * действие держит ядро, загружаются, ключи `.env` исключаются системными настройками, всё прочее —
 * отказ запуска с именем ключа. Слой человека остаётся `on`; запреты репозитория-источника ядро
 * несёт данными (`repo-deny.ts`).
 */
export const QWEN_LAYER: LayerPolicy = {
  readCliMark: qwenTrustMark,
  untrusted: (asked) => asked,
};

/**
 * Настройки сеанса под слой на деле. Проверка доверия выключена в обоих: запись доверия человека
 * знает исходный репозиторий, не копию, а недоверенная папка гасит MCP ядра. `disableAllHooks:
 * false` — системные настройки старше всех: ни файл человека, ни файл репозитория не снимут хук
 * ядра (без него сеанс без политики).
 */
function trustPlan(repo: QwenRepoLayer | null): Record<string, unknown> {
  const base = { security: { folderTrust: { enabled: false } }, disableAllHooks: false };
  if (!repo) return base;
  return {
    ...base,
    // IDE сеанс ядра не подключает: её контекст — ещё один вход мимо ядра.
    ide: { enabled: false },
    ...(repo.dotenv
      ? {
          advanced: {
            excludedEnvVars: [...new Set([...QWEN_DEFAULT_EXCLUDED_ENV, ...repo.dotenv.keys])],
          },
        }
      : {}),
  };
}

/** Пределы локальной модели → ключи `model.generationConfig` (имена — из фактов запуска). */
const LIMIT_KEYS: Record<keyof LocalLimits, 'window' | 'timeout' | 'idle'> = {
  windowTokens: 'window',
  timeoutMs: 'timeout',
  idleMs: 'idle',
};

/** Способ входа CLI по диалекту адреса (`--auth-type`). */
const AUTH_TYPE: Partial<Record<BoundEndpoint['dialect'], string>> = {
  'openai-chat': 'openai',
  'anthropic-messages': 'anthropic',
};

/**
 * Путь диалекта, который CLI НЕ дописывает сам: клиент OpenAI добавляет к адресу только
 * `/chat/completions`, версия — часть адреса; клиент Anthropic строит `/v1/messages` сам.
 */
const DIALECT_BASE: Partial<Record<BoundEndpoint['dialect'], string>> = {
  'openai-chat': '/v1',
};

/** Возобновление пропавшего разговора (текст CLI). */
const MISSING_CONVERSATION = /No (saved )?session found|session .* not found/i;

export const QWEN_CHANNELS: AdapterChannelSummary[] = envVarsChannels(qwenRunFacts).map(
  (channel) => ({
    via: 'env',
    dialect: channel.dialect,
    keyVar: channel.keyVar,
    perSession: true,
  }),
);

export const QWEN_CAPS: AdapterCaps = {
  resume: true,
  mcp: true,
  strictMcp: true,
  permissionTool: true,
  denyOverlay: true,
  preToolHooks: true,
  layerControl: false,
  // Эха нет: ядро шлёт по одной (03, `caps.attribution = none` → сериализация).
  attribution: false,
  stream: true,
  effort: false,
  images: false,
  subagents: false,
  login: qwenRunFacts.login,
  channels: QWEN_CHANNELS,
  windowEvent: false,
  limitsChannel: 'settings-file',
};

export function bindQwenEndpoint(
  channel: AdapterChannelSummary,
  endpoint: BoundEndpoint,
  limits?: LocalLimits,
): BindOutcome {
  const facts = envVarsChannels(qwenRunFacts).find(
    (c) => c.dialect === channel.dialect && c.dialect === endpoint.dialect,
  );
  const auth = AUTH_TYPE[endpoint.dialect];
  if (channel.via !== 'env' || !facts || !auth) return { ok: false, code: 'no_channel' };
  const env: Record<string, string> = {
    [facts.baseUrlVar]: `${endpoint.baseUrl.replace(/\/+$/, '')}${DIALECT_BASE[endpoint.dialect] ?? ''}`,
  };
  if (facts.keyVar) env[facts.keyVar] = endpoint.key;
  if (facts.modelVar) env[facts.modelVar] = endpoint.model;
  const files: Record<string, string> = {};
  if (limits) {
    const channelFacts = qwenRunFacts.limitsChannel;
    if (channelFacts?.via !== 'settings-file') return { ok: false, code: 'window_untellable' };
    const config: Record<string, number> = {};
    for (const [field, key] of Object.entries(LIMIT_KEYS) as [
      keyof LocalLimits,
      'window' | 'timeout' | 'idle',
    ][]) {
      const name = channelFacts.keys[key];
      if (!name) return { ok: false, code: 'window_untellable' };
      config[name] = limits[field];
    }
    files[FILES.system] = JSON.stringify(nest(channelFacts.path, config));
  }
  const binding: EndpointBinding = { env, argv: ['--auth-type', auth], files };
  return { ok: true, binding };
}

/**
 * Команда хука без кавычек. CLI на Windows запускает хук `cmd /d /s /c <команда>` без
 * дословной передачи аргументов: команда, начатая с кавычки, не находится вовсе, кавычки в
 * аргументах доезжают как есть (проба 28.10, 0.24.3). Слова без пробелов везде идут голыми;
 * слово с пробелом так не выразить — `null`, и сеанс отказывается: хук ядра, который CLI не
 * запустит, — это сессия без политики.
 */
export function qwenHookCommand(command: string): string | null {
  const tokens = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '');
  if (tokens.length === 0 || tokens.some((t) => !HOOK_WORD.test(t))) return null;
  return tokens.join(' ');
}

/**
 * Слово команды хука, которое `cmd /d /s /c` и `sh -c` передают как есть (F-41): буквы любого
 * алфавита, цифры и `_ . / : \ @ + , = -`; `~` — не первым (тильда `sh`, короткие имена 8.3).
 * Метазнаки (`& | < > ^ % ! ( ) ; $ '` и кавычки) разорвали бы или раскрыли команду — CLI
 * запустил бы не хук ядра, а сбой хука CLI пропускает (fail-open).
 */
const HOOK_WORD = /^[\p{L}\p{N}_./:\\@+,=-][\p{L}\p{N}_./:\\@+,=~-]*$/u;

/** Значение флага с `-` впереди yargs CLI прочёл бы как свои флаги (`-y` — yolo, F-14). */
const dashLed = (value: string): boolean => value.startsWith('-');

function nest(path: readonly string[], leaf: Record<string, unknown>): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), leaf);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Глубокое слияние объектов настроек (массивы и листья — из `over`). */
function merge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const was = out[key];
    out[key] = isObject(was) && isObject(value) ? merge(was, value) : value;
  }
  return out;
}

export function planQwen(
  spec: SessionSpec,
  binding: EndpointBinding | null,
  layer: LayerRun,
): SdkLaunchPlan {
  // Недоверенная копия: слой копии CLI загрузит — ядро снимает, что снимается (F-86, H2).
  const repo = layer.repoLayer ? null : qwenRepoLayer(spec.cwd, homeDir(spec.env.pin));
  const extraTools = spec.tools === 'read-only' ? READ_ONLY_DENIED : [];
  const deny = qwenDenyRules(spec.deny, spec.cwd, extraTools, platformPaths(spec));
  // Недоверенная копия: файл репозитория CLI не читает — его запреты несёт ядро (F-86).
  const repoDeny = layer.repoLayer ? null : qwenRepoDeny(spec);
  // Вопрос о праве идёт строкой протокола: сервер права CLI не нужен и в его список не попадает.
  const servers = Object.entries(spec.mcpServers).filter(
    ([name]) => name !== spec.permitServer?.name,
  );

  const hook = spec.coreHook ? qwenHookCommand(spec.coreHook) : null;
  const settings: Record<string, unknown> = {
    ...trustPlan(repo),
    permissions: { deny: [...new Set([...(repoDeny?.rules ?? []), ...deny.rules])] },
    ...(hook
      ? { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hook }] }] } }
      : {}),
    mcpServers: Object.fromEntries(
      servers.map(([name, s]) => [
        name,
        { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}), trust: false },
      ]),
    ),
  };
  const fromBinding = binding?.files[FILES.system];
  const merged = fromBinding
    ? merge(settings, JSON.parse(fromBinding) as Record<string, unknown>)
    : settings;

  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--approval-mode',
    'default',
    // Бриф — свободный текст: отдельным словом yargs CLI разобрал бы «- y…» как флаги (`-y` —
    // yolo), форма `--флаг=значение` берёт всё после `=` как есть (F-14).
    `--append-system-prompt=${spec.brief}`,
    // Строгий список: только серверы шага (пустое имя — ни одного сервера человека).
    '--allowed-mcp-server-names',
    ...(servers.length > 0 ? servers.map(([name]) => name) : ['']),
  ];
  // Id разговора CLI — производный от id ядра (`session-id.ts`): UUIDv7 ядра CLI не берёт, а
  // возобновление по id сеанса ядра из журнала выводит тот же разговор заново.
  if (spec.resume) {
    const conversation = spec.resume.conversationId;
    args.push('--resume', qwenSessionId(conversation) ?? conversation);
  } else {
    const own = qwenSessionId(spec.sessionId);
    if (own) args.push('--session-id', own);
  }
  if (spec.model) args.push(`--model=${spec.model}`);
  if (deny.excluded.length > 0) args.push('--exclude-tools', ...deny.excluded);

  const env: Record<string, string> = {
    QWEN_CODE_SYSTEM_SETTINGS_PATH: join(spec.dir, FILES.system),
  };
  const details = [
    repoDeny ? repoDenyDetail(repoDeny) : undefined,
    repo ? qwenRepoLayerDetail(repo) : undefined,
  ].filter(Boolean);
  const layerDetail = details.length > 0 ? details.join('; ') : undefined;
  return {
    args,
    env,
    files: { [FILES.system]: JSON.stringify(merged, null, 2) },
    ...(layerDetail ? { layerDetail } : {}),
  };
}

/** Сеанс, который Qwen Code исполнить честно не может. */
export function refuseQwen(
  spec: SessionSpec,
  options: QwenAdapterOptions = {},
  layer: LayerRun = trustedLayer(spec),
): string | null {
  if (spec.layer.hooks !== 'on') return `layer ${spec.layer.hooks} is not controllable`;
  // Недоверенная копия несёт запреты репозитория данными: файл не разобран — отказ (F-86).
  if (!layer.repoLayer) {
    const refused =
      repoDenyRefusal(qwenRepoDeny(spec)) ??
      qwenRepoLayerRefusal(qwenRepoLayer(spec.cwd, homeDir(spec.env.pin)));
    if (refused) return refused;
  }
  // Спека 03 и P81: хук ядра ставится в каждом режиме. Поиск без `path` и маска `../**` правилом
  // CLI не ловятся (F-13), путь на другом корне не выражается — второй замок только хук (F-10).
  if (!spec.coreHook && !options.unhookedForTests) {
    return 'no core hook: the session would run without the core PreToolUse hook';
  }
  if (spec.coreHook && qwenHookCommand(spec.coreHook) === null) {
    return 'core hook command has whitespace or a shell metacharacter; the CLI cannot run it unquoted';
  }
  if (spec.resume && dashLed(spec.resume.conversationId)) {
    return `resume id is not a conversation id: ${JSON.stringify(spec.resume.conversationId)}`;
  }
  // Списки (`--allowed-mcp-server-names`, `--exclude-tools`) идут словами: имя с `-` впереди
  // yargs прочёл бы флагом.
  const listed = [...Object.keys(spec.mcpServers), ...spec.deny.mcpTools].filter(dashLed);
  if (listed.length > 0) return `server or tool name starts with "-": ${listed.join(', ')}`;
  const unexpressed = qwenDenyRules(spec.deny, spec.cwd).unexpressed;
  if (unexpressed.length > 0 && !spec.coreHook) {
    return `deny path on another root and no core hook to guard it: ${unexpressed.join(', ')}`;
  }
  return null;
}

/** Дом ядра и файлы токенов: их предки — корни поиска под запретом (F-13). */
function platformPaths(spec: SessionSpec): string[] {
  return [spec.platform.coreHome, ...spec.platform.tokenFiles];
}

export interface QwenAdapterOptions extends SdkAdapterOptions {
  /**
   * Только набор соответствия над подставным CLI (он хуков не исполняет): сеанс без хука ядра
   * не отказывается. Реестр ядра этот флаг не ставит никогда.
   */
  unhookedForTests?: true;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Ответ на `can_use_tool`, который CLI исполнит как разрешение, — только целый `allow` с
 * объектом `updatedInput`; всё прочее (сбой кодека, пустой ответ) уходит отказом, а не молчанием:
 * без ответа CLI ждёт посреди хода (verify-cli V5, F-42).
 */
export function qwenPermitReply(reply: unknown): unknown {
  if (isRecord(reply) && reply.behavior === 'allow' && isRecord(reply.updatedInput)) return reply;
  if (isRecord(reply) && reply.behavior === 'deny' && typeof reply.message === 'string') {
    return reply;
  }
  return { behavior: 'deny', message: 'The core sent no valid permission answer; denied.' };
}

export function createQwenAdapter(options: QwenAdapterOptions = {}): SdkAdapter {
  const adapter = createSdkAdapter(
    {
      id: qwenRunFacts.id,
      caps: QWEN_CAPS,
      command: qwenRunFacts.binary.command,
      echo: false,
      inBandPermit: true,
      // Без `initialize` первой строкой CLI в «прямом» режиме: вопрос о праве висит молча
      // (живая проба 28.10, 0.24.3 — ни `can_use_tool`, ни отказа).
      initialize: { subtype: 'initialize' },
      bindEndpoint: bindQwenEndpoint,
      layer: QWEN_LAYER,
      readLayer: qwenReadLayer,
      plan: planQwen,
      refuse: (spec, layer) => refuseQwen(spec, options, layer),
      mapPermission: mapQwenPermission,
      classifyError: (text) => (MISSING_CONVERSATION.test(text) ? 'fresh-required' : null),
    },
    options,
  );
  const answer = adapter.answerPermit?.bind(adapter);
  if (answer) {
    adapter.answerPermit = (handle, requestId, reply) =>
      answer(handle, requestId, qwenPermitReply(reply));
  }
  return adapter;
}
