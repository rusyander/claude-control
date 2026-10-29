import { join } from 'node:path';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { envVarsChannels } from '@agentdeck/providers/channels';
import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';
import type {
  AdapterCaps,
  AdapterChannelSummary,
  BindOutcome,
  BoundEndpoint,
  EndpointBinding,
  LayerRun,
  LocalLimits,
  SessionSpec,
} from '../adapter.types.ts';
import { READ_ONLY_DENIED } from '../read-only.ts';
import { trustedLayer, type LayerPolicy } from '../sdk-stream/layer-run.ts';
import {
  createSdkAdapter,
  type SdkAdapter,
  type SdkAdapterOptions,
  type SdkLaunchPlan,
} from '../sdk-stream/sdk-adapter.ts';
import {
  claudeAbsolutePattern,
  claudeDenyRules,
  keepHumanAllow,
  mapClaudePermission,
} from './permission.ts';
import {
  claudeConfigDir,
  layerHooks,
  readUserLayer,
  userLayerFiles,
  type HookTable,
} from './user-layer.ts';
import { claudeReadLayer } from './read-layer.ts';
import { claudeRepoDeny, claudeRepoRules } from './repo-deny.ts';
import { repoDenyDetail, repoDenyRefusal } from '../sdk-stream/repo-deny.ts';
import { claudeTrustMark } from './trust.ts';

/**
 * Переходник Claude Code (03 §Claude adapter). Факты запуска — из `@agentdeck/providers`;
 * флаги — как их документирует `.agent/provider-formats.agent.md` для установленной версии.
 * Права всегда `default`: авто-режимы человека до сессии ядра не доезжают (их намерение
 * исполняет `policy/permit` внутри копии).
 */

const FILES = {
  settings: 'claude/settings.json',
  mcp: 'claude/mcp.json',
  brief: 'claude/brief.md',
  observed: 'claude/observed-hooks.json',
} as const;

/** Пределы локальной модели → переменные окружения (имена — из фактов запуска). */
const LIMIT_VARS: Record<keyof LocalLimits, string[]> = {
  windowTokens: ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'],
  timeoutMs: ['CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS', 'API_TIMEOUT_MS'],
  idleMs: ['CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Возобновление пропавшего разговора: CLI пишет это строкой `result error_during_execution
 * {errors[]}` и в stderr, потом выходит с кодом 1 (запись 28.10, 2.1.310). Только целая строка
 * (или ошибка из списка через `; `): та же фраза внутри вывода хука или текста модели — не отказ
 * разговора (F-95).
 */
const MISSING_CONVERSATION = /(?:^|; )No conversation found with session ID: [\w-]+\s*$/im;

/** Ошибка CLI, после которой нужен новый разговор (пропавший при возобновлении). */
export function classifyClaudeError(text: string): 'fresh-required' | null {
  return MISSING_CONVERSATION.test(text) ? 'fresh-required' : null;
}

/** Имя разговора CLI: буквы, цифры, `_ . : -`, не с `-` впереди. */
const RESUME_ID = /^[A-Za-z0-9][\w.:-]*$/;

export const CLAUDE_CHANNELS: AdapterChannelSummary[] = envVarsChannels(claudeRunFacts).map(
  (channel) => ({
    via: 'env',
    dialect: channel.dialect,
    keyVar: channel.keyVar,
    perSession: true,
  }),
);

export const CLAUDE_CAPS: AdapterCaps = {
  resume: true,
  mcp: true,
  strictMcp: true,
  permissionTool: true,
  denyOverlay: true,
  preToolHooks: true,
  layerControl: true,
  attribution: true,
  stream: true,
  effort: true,
  // Без случая в наборе соответствия возможность не объявляется (P121).
  images: false,
  subagents: false,
  login: claudeRunFacts.login,
  channels: CLAUDE_CHANNELS,
  windowEvent: false,
  limitsChannel: 'env',
};

/** Учётки и переключатели облака самого Claude Code, которых нет в фактах каналов. */
const CLAUDE_OWN_CREDENTIALS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
];

/**
 * Учётки вендоров, которые CLI или любой процесс модели взял бы из окружения: свои Claude Code и
 * ключи каждого CLI из фактов запуска (ключ API вендора и ключ каждого канала окружением).
 */
export const VENDOR_CREDENTIALS: readonly string[] = [
  ...new Set([
    ...CLAUDE_OWN_CREDENTIALS,
    ...CLI_RUN_FACTS.flatMap((facts) => [
      ...facts.vendorApi.keyVars,
      ...facts.channels.flatMap((c) => (c.via === 'env' && c.keyVar ? [c.keyVar] : [])),
    ]),
  ]),
];

/**
 * Привязка адреса сеанса. Каждая ДРУГАЯ учётка вендора гасится пустым значением (F-09): пин
 * задачи несёт окружение человека, и `ANTHROPIC_API_KEY` иначе доходил бы до любого Bash
 * модели — то есть до привязанного, не вендорского адреса (проба K7b). Пусто, а не «удалить»:
 * слой сеанса у пускателя только перекрывает пин, а пустое значение CLI считает отсутствием.
 */
export function bindClaudeEndpoint(
  channel: AdapterChannelSummary,
  endpoint: BoundEndpoint,
  limits?: LocalLimits,
): BindOutcome {
  const facts = envVarsChannels(claudeRunFacts).find(
    (c) => c.dialect === channel.dialect && c.dialect === endpoint.dialect,
  );
  if (channel.via !== 'env' || !facts) return { ok: false, code: 'no_channel' };
  const env: Record<string, string> = Object.fromEntries(
    VENDOR_CREDENTIALS.filter((name) => name !== facts.keyVar).map((name) => [name, '']),
  );
  // Claude Code сам добавляет путь диалекта (`/v1/messages`) к origin.
  env[facts.baseUrlVar] = endpoint.baseUrl;
  if (facts.keyVar) env[facts.keyVar] = endpoint.key;
  if (facts.modelVar) env[facts.modelVar] = endpoint.model;
  if (limits) {
    const known =
      claudeRunFacts.limitsChannel?.via === 'env' ? claudeRunFacts.limitsChannel.vars : [];
    for (const [field, names] of Object.entries(LIMIT_VARS) as [keyof LocalLimits, string[]][]) {
      for (const name of names) {
        if (!known.includes(name)) return { ok: false, code: 'window_untellable' };
        env[name] = String(limits[field]);
      }
    }
  }
  const binding: EndpointBinding = { env, argv: [], files: {} };
  return { ok: true, binding };
}

function mergeHooks(...tables: HookTable[]): HookTable {
  const out: HookTable = {};
  for (const table of tables) {
    for (const [event, groups] of Object.entries(table)) (out[event] ??= []).push(...groups);
  }
  return out;
}

/**
 * Правка настроек Claude Code запрещена и там, где их не перечислить путём: свой каталог
 * конфигурации человека (хуки следующих сеансов) и `.claude` в любом подкаталоге cwd (шаг,
 * начатый там, взял бы их как настройки проекта). Каталоги `.claude` на cwd и выше несёт уже
 * запрет платформы (`withPlatformDeny`).
 */
function settingsEditDeny(spec: SessionSpec): string[] {
  const nested = claudeAbsolutePattern(spec.cwd);
  return [
    `Edit(${nested}/**/.claude)`,
    `Edit(${nested}/**/.claude/**)`,
    ...claudeDenyRules(
      {
        paths: [],
        editPaths: [claudeConfigDir(spec.env.pin)],
        commands: [],
        mcpTools: [],
        tools: [],
      },
      [],
      spec.cwd,
    ).rules,
  ];
}

/**
 * Недоверенная копия (F-86): `on` идёт как `observe` — CLI с `--setting-sources ''` не читает
 * файлы репозитория сам, а ядро не возвращает их через `--settings` (`repoLayer: false`) —
 * кроме `permissions.deny`: его ядро читает данными и несёт в `--settings` (`repo-deny.ts`).
 */
export const CLAUDE_LAYER: LayerPolicy = {
  readCliMark: claudeTrustMark,
  untrusted: (asked) => (asked === 'on' ? 'observe' : asked),
};

export function planClaude(
  spec: SessionSpec,
  binding: EndpointBinding | null | undefined,
  layer: LayerRun,
): SdkLaunchPlan {
  const path = (name: string): string => join(spec.dir, name);
  const extraTools = spec.tools === 'read-only' ? READ_ONLY_DENIED : [];
  const deny = claudeDenyRules(spec.deny, extraTools, spec.cwd);
  const permitTool = spec.permitServer
    ? `mcp__${spec.permitServer.name}__${spec.permitServer.tool}`
    : null;

  const coreHooks: HookTable = spec.coreHook
    ? { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: spec.coreHook }] }] }
    : {};
  // Слой на деле, не запрошенный: недоверенная копия в `on` сюда приходит уже `observe`.
  const mode = layer.ran;
  const user =
    mode === 'on' ? null : readUserLayer(userLayerFiles(spec.env.pin, spec.cwd, layer.repoLayer));
  const layered = user ? layerHooks(user, mode, spec.recorder) : { hooks: {}, observed: [] };
  // Привязка адреса старше окружения из настроек человека и репозитория (F-07): `--settings`
  // ядра — источник выше user/project, и в `on` тоже, иначе `env` репозитория уводит сеанс
  // на свой адрес со своим ключом (проба K1).
  const settingsEnv = { ...(user?.env ?? {}), ...(binding?.env ?? {}) };
  // Недоверенная копия: из файлов репозитория — только `deny`, данными (F-86).
  const repoDeny = layer.repoLayer ? null : claudeRepoDeny(spec);

  const settings = {
    permissions: {
      ...(user ? { allow: user.allow.filter(keepHumanAllow), ask: user.ask } : {}),
      deny: [
        ...new Set([
          ...(user?.deny ?? []),
          ...(repoDeny ? claudeRepoRules(repoDeny, spec) : []),
          ...deny.rules,
          ...settingsEditDeny(spec),
        ]),
      ],
      defaultMode: 'default',
    },
    ...(Object.keys(settingsEnv).length > 0 ? { env: settingsEnv } : {}),
    // `disableAllHooks: true` человека в `on` снял бы и хук ядра (проба K2): наш `--settings`
    // старше, значение ядра — «хуки включены» (F-08).
    disableAllHooks: false,
    hooks: mergeHooks(layered.hooks, coreHooks),
  };
  const files: Record<string, string> = {
    [FILES.settings]: JSON.stringify(settings, null, 2),
    [FILES.mcp]: JSON.stringify({
      mcpServers: Object.fromEntries(
        Object.entries(spec.mcpServers).map(([name, s]) => [
          name,
          { type: 'stdio', command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) },
        ]),
      ),
    }),
    [FILES.brief]: spec.brief,
  };
  if (layered.observed.length > 0) files[FILES.observed] = JSON.stringify(layered.observed);

  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-mode',
    'default',
    '--settings',
    path(FILES.settings),
    '--strict-mcp-config',
    '--mcp-config',
    path(FILES.mcp),
    '--append-system-prompt-file',
    path(FILES.brief),
  ];
  // `on` — источники CLI как есть; иначе ни один файл человека, его права — нашим `--settings`.
  if (mode !== 'on') args.push('--setting-sources', '');
  if (spec.resume) args.push('--resume', spec.resume.conversationId);
  else if (UUID.test(spec.sessionId)) args.push('--session-id', spec.sessionId);
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort && claudeRunFacts.effort?.values.includes(spec.effort)) {
    args.push('--effort', spec.effort);
  }
  const disallowed = [...deny.disallowed, ...(permitTool ? [permitTool] : [])];
  if (disallowed.length > 0) args.push('--disallowedTools', disallowed.join(','));
  // Без сервера разрешений всё, что спросило бы, отказывается сразу (fail-closed).
  if (permitTool) args.push('--permission-prompt-tool', permitTool);
  else args.push('--permission-prompts', 'none');

  // Сессия ядра не обновляет CLI посреди задачи: версия — та, по справке которой собран argv.
  const env: Record<string, string> = { DISABLE_AUTOUPDATER: '1' };
  const layerDetail = repoDeny ? repoDenyDetail(repoDeny) : undefined;
  return { args, env, files, ...(layerDetail ? { layerDetail } : {}) };
}

export interface ClaudeAdapterOptions extends SdkAdapterOptions {
  /**
   * Только набор соответствия над подставным CLI (он хуков не исполняет): сеанс без хука ядра
   * не отказывается. Реестр ядра этот флаг не ставит никогда.
   */
  unhookedForTests?: true;
}

/** Сеанс, который Claude Code исполнить честно не может. */
export function refuseClaude(
  spec: SessionSpec,
  options: ClaudeAdapterOptions = {},
  layer: LayerRun = trustedLayer(spec),
): string | null {
  // Спека 03 и P81: хук ядра ставится в каждом режиме; без него — второго замка нет (F-10).
  if (!spec.coreHook && !options.unhookedForTests)
    return 'no core hook: the session would run without the core PreToolUse hook';
  // Имя разговора — значение флага; с `-` впереди CLI прочёл бы его как свой флаг (F-95).
  if (spec.resume && !RESUME_ID.test(spec.resume.conversationId)) {
    return `resume id is not a conversation id: ${JSON.stringify(spec.resume.conversationId)}`;
  }
  if (layer.ran !== 'on') {
    // Файл человека не разобран — его запреты не дошли бы до сеанса молча (F-35). Файлы
    // недоверенного репозитория не читаются вовсе — их порча сеанс не останавливает.
    const files = userLayerFiles(spec.env.pin, spec.cwd, layer.repoLayer);
    const unreadable = readUserLayer(files).unreadable;
    if (unreadable.length > 0) {
      return `human settings unreadable, their deny rules would be lost: ${unreadable.join(', ')}`;
    }
  }
  // Недоверенная копия несёт запреты репозитория данными: файл не разобран — отказ (F-86).
  if (!layer.repoLayer) return repoDenyRefusal(claudeRepoDeny(spec));
  return null;
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): SdkAdapter {
  return createSdkAdapter(
    {
      id: claudeRunFacts.id,
      caps: CLAUDE_CAPS,
      command: claudeRunFacts.binary.command,
      echo: true,
      bindEndpoint: bindClaudeEndpoint,
      layer: CLAUDE_LAYER,
      readLayer: claudeReadLayer,
      refuse: (spec, layer) => refuseClaude(spec, options, layer),
      plan: planClaude,
      mapPermission: mapClaudePermission,
      classifyError: classifyClaudeError,
    },
    options,
  );
}
