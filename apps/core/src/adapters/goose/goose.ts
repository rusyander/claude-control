import { join } from 'node:path';
import { GOOSE_RUN_PROVIDER, gooseRunFacts } from '@agentdeck/providers/goose';
import type { EnvRunChannel } from '@agentdeck/providers/types';
import type { GooseMode } from '@agentdeck/contracts/permissions';
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
import { acpViewInput, createAcpDialect, type AcpDialectData } from '../rpc-stdio/acp.ts';
import { acpMcpServers, splitCarried } from '../mcp-carry.ts';
import { gooseEconomy } from '../economy-carry.ts';
import {
  createRpcAdapter,
  type RpcAdapter,
  type RpcAdapterOptions,
} from '../rpc-stdio/rpc-adapter.ts';
import type { SdkLaunchPlan } from '../sdk-stream/sdk-adapter.ts';
import { gooseConfigDir, gooseMcpSource } from './mcp-source.ts';
import { GOOSE_PERMIT_CODEC, gooseToolName, mapGoosePermission } from './permission.ts';
import {
  GOOSE_HOME_DIR,
  gooseOwnsTranscript,
  gooseResume,
  gooseTranscriptPresent,
} from './transcript.ts';

/**
 * Переходник Goose (1.54) поверх `goose acp` — ACP по stdio. Корень Goose у каждого сеанса свой
 * (`GOOSE_PATH_ROOT` = `<сеанс>/goose-home`: config, data, state), адрес модели — окружением
 * провайдера `openai`, связка ключей выключена. Хук ядра — плагин Open Plugins в этом корне
 * (`.agents/plugins/agentdeck/hooks/hooks.json`, событие `PreToolUse`): отказ — код 2, сбой хука
 * — отказ (`on_failure: block`). Без этого Goose при сбое хука вызов исполняет (проба 02.11).
 *
 * Возможности — только доказанные пробой 02.11 на stub-model: хук до вызова (отказ держится в
 * режимах auto/approve/smart_approve), поток текста, ход под своим запросом, продолжение разговора
 * (`session/load` по базе с одним этим разговором в доме сеанса — `transcript.ts`), серверы MCP
 * шага через ACP `session/new` (расширения человека не стартуют — s10 p6). Картинок, подагентов и
 * управления слоем нет: непроверенное объявлять нельзя (P121).
 */

const HOME = GOOSE_HOME_DIR;
const PLUGIN = `${HOME}/.agents/plugins/agentdeck`;
/** Режим права Goose: каждый вызов — вопрос, ответ на него у судьи ядра (хук стоит всё равно). */
export const GOOSE_MODE = 'approve' satisfies GooseMode;

export const GOOSE_FILES = {
  plugin: `${PLUGIN}/.plugin/plugin.json`,
  hooks: `${PLUGIN}/hooks/hooks.json`,
  config: `${HOME}/config/config.yaml`,
} as const;

/**
 * Встроенные расширения Goose, которые сеанс выключает. Каталог дома человека Goose берёт у ОС, не
 * из USERPROFILE/HOME (проба 02.11): `skills` читает `~/.agents/skills` и `~/.claude/skills`
 * человека и кладёт их в системную подсказку модели, `summon` грузит те же навыки и запускает
 * подагентов (`delegate`), которых переходник не объявляет.
 */
export const GOOSE_OFF_EXTENSIONS = ['skills', 'summon'] as const;

/**
 * Сеанс без инструментов (`tools: 'none'`, вопрос «ask», s10 p10): выключены ВСЕ встроенные
 * расширения платформы Goose 1.54 (список — реестр `platform_extensions` сборки). Проба 02.11: по
 * умолчанию запрос модели несёт `shell`/`edit`/`write`/`tree`/`analyze`/`read_image`, `apps__*`,
 * `extensionmanager__*`; с этим списком — ни одного. Серверы MCP шага идут ACP `session/new` и
 * остаются.
 */
export const GOOSE_NONE_EXTENSIONS = [
  'analyze',
  'apps',
  'chatrecall',
  'code_execution',
  'developer',
  'extensionmanager',
  'orchestrator',
  'scheduler',
  'skills',
  'summarize',
  'summon',
  'todo',
  'tom',
] as const;

/** `config.yaml` корня сеанса: только выключение расширений, остальное Goose берёт из окружения. */
export function gooseConfigFile(off: readonly string[] = GOOSE_OFF_EXTENSIONS): string {
  const lines = ['extensions:'];
  for (const name of off) {
    lines.push(
      `  ${name}:`,
      '    enabled: false',
      '    type: platform',
      `    name: ${name}`,
      '    description: off',
      '    bundled: true',
    );
  }
  return `${lines.join('\n')}\n`;
}

export const GOOSE_CHANNELS: AdapterChannelSummary[] = [
  // Провайдер `openai` целиком из окружения сеанса (окружение старше `config.yaml`).
  { via: 'env', dialect: 'openai-chat', keyVar: 'OPENAI_API_KEY', perSession: true },
];

export const GOOSE_CAPS: AdapterCaps = {
  resume: true,
  mcp: true,
  strictMcp: true,
  permissionTool: false,
  // `permission.yaml` Goose — по имени инструмента, не по команде: оверлей запретов не выразить.
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
  login: gooseRunFacts.login,
  channels: GOOSE_CHANNELS,
  windowEvent: false,
  limitsChannel: null,
  // Потерю входа (этап 12, P170) не называет: текста и чтения входа в наборе соответствия нет.
  loginLost: false,
};

/** Канал Goose — построитель фактов запуска (`@agentdeck/providers/goose`), адрес с `/v1`. */
export function bindGooseEndpoint(
  channel: AdapterChannelSummary,
  endpoint: BoundEndpoint,
): BindOutcome {
  if (channel.dialect !== 'openai-chat' || endpoint.dialect !== 'openai-chat') {
    return { ok: false, code: 'no_channel' };
  }
  const build = gooseRunFacts.channels.find(
    (c): c is EnvRunChannel => c.via === 'env' && c.form === 'run' && c.dialect === 'openai-chat',
  )?.build;
  if (!build) return { ok: false, code: 'no_channel' };
  const env = build({
    baseUrl: `${endpoint.baseUrl.replace(/\/+$/, '')}/v1`,
    model: endpoint.model,
    key: endpoint.key,
  });
  if (env.GOOSE_PROVIDER !== GOOSE_RUN_PROVIDER) return { ok: false, code: 'no_channel' };
  const binding: EndpointBinding = { env, argv: [], files: {} };
  return { ok: true, binding };
}

/** Каталоги Goose человека: его конфиг и ключи судья не даёт читать. */
export function gooseReadLayer(pin: Record<string, string>): ReadLayer {
  const config = gooseConfigDir(pin);
  return { dirs: [], credentials: [join(config, 'config.yaml'), join(config, 'secrets.yaml')] };
}

/**
 * Слой человека не грузится: корень Goose — свой у сеанса, навыки человека выключены вместе с
 * расширениями `skills`/`summon` (дом человека Goose находит через ОС, мимо окружения). Плагины
 * репозитория (`<копия>/.agents/plugins`) Goose грузит сам (проба 02.11) — это названо потерей
 * управления слоем, не скрыто: их хуки могут только отказать вызову, хук ядра стоит рядом.
 */
export function gooseLayer(spec: SessionSpec): LayerRun {
  const asked = spec.layer.hooks;
  return {
    asked,
    ran: 'off',
    repoLayer: false,
    trust: 'none',
    detail:
      'goose: per-session GOOSE_PATH_ROOT, the human config does not load; goose finds the human home through the OS, so the skills and summon extensions are off (they read ~/.agents/skills and ~/.claude/skills); repo plugins under .agents/plugins still load',
    ...(asked === 'off' ? {} : { losses: [`hooks ${asked} -> off: goose has no layer control`] }),
  };
}

export function refuseGoose(spec: SessionSpec): string | null {
  if (!spec.coreHook) {
    return 'no core hook: the session would run without the core PreToolUse hook';
  }
  if (!spec.endpoint) {
    // Свой вход Goose — провайдер и ключи в конфиге человека: сеанс его не читает.
    return 'goose runs only on a routed endpoint: its own provider lives in the human goose config';
  }
  return null;
}

/** `hooks.json` плагина: matcher — регулярное выражение (`*` Goose отбрасывает), сбой — отказ. */
export function gooseHooksFile(coreHook: string): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: coreHook, on_failure: 'block' }],
          },
        ],
      },
    },
    null,
    2,
  );
}

export function planGoose(
  spec: SessionSpec,
  _binding: EndpointBinding | null,
  _layer: LayerRun,
): SdkLaunchPlan {
  const economy = gooseEconomy(spec);
  const lost = [
    ...splitCarried(spec, GOOSE_REMOTE_MCP, 'goose acp declares http only').lost,
    ...economy.lost,
  ];
  return {
    args: ['acp'],
    env: {
      ...economy.env,
      GOOSE_PATH_ROOT: join(spec.dir, HOME),
      GOOSE_MODE,
      GOOSE_DISABLE_KEYRING: '1',
      GOOSE_TELEMETRY_OFF: '1',
      // Навыки человека Goose объявляет и командами ACP (`available_commands_update`): выключено.
      GOOSE_SLASH_COMMANDS_ENABLED: 'false',
    },
    files: {
      [GOOSE_FILES.config]: gooseConfigFile(
        spec.tools === 'none' ? GOOSE_NONE_EXTENSIONS : GOOSE_OFF_EXTENSIONS,
      ),
      [GOOSE_FILES.plugin]: JSON.stringify({
        name: 'agentdeck',
        version: '1.0.0',
        description: 'agentdeck core PreToolUse hook',
      }),
      [GOOSE_FILES.hooks]: gooseHooksFile(spec.coreHook as string),
    },
    ...(lost.length > 0 ? { layerLosses: lost } : {}),
  };
}

/**
 * Удалённые серверы MCP (s10 p8): Goose 1.54 объявляет `mcpCapabilities {http:true, sse:false}`
 * (запись `__fixtures__/basic.jsonl`) — streamable HTTP идёт ACP, SSE назван потерей.
 */
export const GOOSE_REMOTE_MCP = { http: true, sse: false } as const;

/** Режим Goose из ответа `session/new`: другой — окружение сеанса не дошло, запуск сорван. */
export function checkGooseSession(result: Record<string, unknown>): string | null {
  const modes = result.modes as { currentModeId?: unknown } | undefined;
  return modes?.currentModeId === GOOSE_MODE
    ? null
    : `goose mode ${String(modes?.currentModeId)}, expected ${GOOSE_MODE}`;
}

export function createGooseAdapter(options: RpcAdapterOptions = {}): RpcAdapter {
  return createRpcAdapter(
    {
      id: gooseRunFacts.id,
      caps: GOOSE_CAPS,
      command: gooseRunFacts.binary.command,
      // Провайдер и ключи Goose — в конфиге человека, сеанс его не читает: маршрута входа нет.
      cliLogin: false,
      readLayer: gooseReadLayer,
      mcpSource: gooseMcpSource,
      bindEndpoint: bindGooseEndpoint,
      layer: gooseLayer,
      refuse: refuseGoose,
      plan: planGoose,
      // Флага без записи у ACP Goose нет; база сеансов — под своим GOOSE_PATH_ROOT сеанса.
      ephemeral: 'session-home',
      resume: gooseResume,
      ownsTranscript: gooseOwnsTranscript,
      transcriptPresent: gooseTranscriptPresent,
      toolsNone: true,
      dialectInput: ({ spec, permit }): AcpDialectData => ({
        cli: gooseRunFacts.id,
        cwd: spec.cwd,
        permit,
        mcpServers: acpMcpServers(spec, GOOSE_REMOTE_MCP),
        ...(spec.resume ? { load: spec.resume.conversationId } : {}),
        ...(spec.endpoint ? { model: spec.endpoint.endpoint.model } : {}),
      }),
      dialect: (data) =>
        createAcpDialect({
          ...data,
          mapPermission: mapGoosePermission,
          toolName: gooseToolName,
          checkSession: checkGooseSession,
        }),
      viewInput: acpViewInput,
      mapPermission: mapGoosePermission,
      permitCodec: GOOSE_PERMIT_CODEC,
    },
    options,
  );
}
