import { join } from 'node:path';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
import type { EnvRunChannel } from '@agentdeck/providers/types';
import type { KimiAcpMode, KimiMode } from '@agentdeck/contracts/permissions';
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
import { ACP_PERMIT_CODEC, withAcpInput } from '../acp-input.ts';
import { acpViewInput, createAcpDialect, type AcpDialectData } from '../rpc-stdio/acp.ts';
import { acpMcpServers, carriedMcp } from '../mcp-carry.ts';
import { kimiEconomy } from '../economy-carry.ts';
import { kimiMcpSource } from './mcp-source.ts';
import {
  createRpcAdapter,
  type RpcAdapter,
  type RpcAdapterOptions,
} from '../rpc-stdio/rpc-adapter.ts';
import type { SdkLaunchPlan } from '../sdk-stream/sdk-adapter.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { fillKimiInput, kimiToolName, mapKimiPermission } from './permission.ts';
import {
  KIMI_HOME_DIR,
  kimiOwnsTranscript,
  kimiResume,
  kimiTranscriptPresent,
} from './transcript.ts';

/**
 * Переходник Kimi Code (2.4.1) поверх `kimi acp` — ACP по stdio. Дом CLI у каждого сеанса свой
 * (`KIMI_CODE_HOME` = `<сеанс>/kimi-home`: config.toml, вход, плагины), модель — окружением
 * `KIMI_MODEL_*` из фактов запуска (CLI заводит из них `__kimi_env_model__`, она перебивает модель
 * конфига — проверяется в ответе `session/new`).
 *
 * Защита ядра — хук `PreToolUse` в `config.toml` сеанса (проба 02.11: отказ держит push и
 * `env git push` в режимах default/auto/yolo/plan, `git status` до git доходит). Хук Kimi
 * «открыт при сбое»: упавший хук вызов НЕ закрывает, поэтому команда хука завёрнута в
 * `… || exit 2` — любой ненулевой выход становится отказом. Оверлея нет: правила `permission`
 * конфига под ACP не действуют (проба 02.11, обе формы). Второй замок — вопрос о праве в режиме
 * `default`: ответ у судьи ядра. Продолжение — `session/load` по каталогу разговора, скопированному
 * в дом сеанса (`transcript.ts`). Серверы MCP шага — через ACP `session/new`; `mcp.json` человека и
 * репозитория не грузится (s10 p6).
 */

const HOME = KIMI_HOME_DIR;
/**
 * Два словаря режима, не один (проба 2.4.1, 02.11). В config.toml — `default_permission_mode` из
 * `manual|auto|yolo` (тот же набор, что пишет панель); `default` там недопустим, и Kimi молча
 * выбросил бы ключ. По ACP сеанс отвечает своим режимом из `default|plan|auto|yolo`, и он всегда
 * `default` (= manual: каждый вызов с вопросом о праве), что бы ни стояло в конфиге.
 */
export const KIMI_PERMISSION_MODE: KimiMode = 'manual';
/** Режим сеанса из ответа `session/new`: иной — вопрос о праве до судьи ядра не дойдёт, запуск сорван. */
export const KIMI_ACP_MODE: KimiAcpMode = 'default';
/** Модель, которую Kimi заводит из `KIMI_MODEL_*`: иная — адрес сеанса не дошёл. */
export const KIMI_ENV_MODEL = '__kimi_env_model__';
/** Ожидание хука, секунды: истёкший хук Kimi пропускает вызов — запас как у Claude. */
export const KIMI_HOOK_TIMEOUT = 600;

export const KIMI_FILES = { config: `${HOME}/config.toml` } as const;

export const KIMI_CHANNELS: AdapterChannelSummary[] = [
  { via: 'env', dialect: 'openai-chat', keyVar: 'KIMI_MODEL_API_KEY', perSession: true },
];

export const KIMI_CAPS: AdapterCaps = {
  resume: true,
  mcp: true,
  strictMcp: true,
  permissionTool: false,
  // `permission` конфига под ACP не действует: оверлей запретов не выразить.
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
  login: kimiRunFacts.login,
  channels: KIMI_CHANNELS,
  windowEvent: false,
  limitsChannel: null,
  // Потерю входа (этап 12, P170) не называет: текста и чтения входа в наборе соответствия нет.
  loginLost: false,
};

/** Канал Kimi — построитель фактов запуска (`@agentdeck/providers/kimi`), адрес с `/v1`. */
export function bindKimiEndpoint(
  channel: AdapterChannelSummary,
  endpoint: BoundEndpoint,
): BindOutcome {
  if (channel.dialect !== 'openai-chat' || endpoint.dialect !== 'openai-chat') {
    return { ok: false, code: 'no_channel' };
  }
  const build = kimiRunFacts.channels.find(
    (c): c is EnvRunChannel => c.via === 'env' && c.form === 'run' && c.dialect === 'openai-chat',
  )?.build;
  if (!build) return { ok: false, code: 'no_channel' };
  const env = build({
    baseUrl: `${endpoint.baseUrl.replace(/\/+$/, '')}/v1`,
    model: endpoint.model,
    key: endpoint.key,
  });
  const binding: EndpointBinding = { env, argv: [], files: {} };
  return { ok: true, binding };
}

/** Дом Kimi человека: конфиг (ключи провайдеров), MCP и вход судья не даёт читать. */
export function kimiReadLayer(pin: Record<string, string>): ReadLayer {
  const home = pin.KIMI_CODE_HOME || join(homeDir(pin), '.kimi-code');
  return {
    dirs: [],
    credentials: ['config.toml', 'mcp.json', 'credentials'].map((name) => join(home, name)),
  };
}

export function kimiLayer(spec: SessionSpec): LayerRun {
  const asked = spec.layer.hooks;
  return {
    asked,
    ran: 'off',
    repoLayer: false,
    trust: 'none',
    detail:
      'kimi: per-session KIMI_CODE_HOME, the human config, plugins and MCP do not load; repo AGENTS.md and skills still load',
    ...(asked === 'off' ? {} : { losses: [`hooks ${asked} -> off: kimi has no layer control`] }),
  };
}

export function refuseKimi(spec: SessionSpec): string | null {
  if (!spec.coreHook) {
    return 'no core hook: the session would run without the core PreToolUse hook';
  }
  if (!spec.endpoint) {
    // Свой вход Kimi (OAuth, ключи) живёт в доме человека: сеанс его не читает.
    return 'kimi runs only on a routed endpoint: its own login lives in the human kimi home';
  }
  return null;
}

/** Строка TOML: экранирование JSON годится для базовой строки TOML. */
const toml = (value: string): string => JSON.stringify(value);

/** `config.toml` сеанса: режим права и хук ядра на каждый вызов, сбой хука — отказ. */
export function kimiConfigFile(coreHook: string): string {
  return [
    `default_permission_mode = ${toml(KIMI_PERMISSION_MODE)}`,
    '',
    '[[hooks]]',
    'event = "PreToolUse"',
    'matcher = ""',
    `command = ${toml(`${coreHook} || exit 2`)}`,
    `timeout = ${KIMI_HOOK_TIMEOUT}`,
    '',
  ].join('\n');
}

/**
 * Удалённые серверы MCP (s10 p8): Kimi 2.4.1 объявляет `mcpCapabilities {http:true, sse:true}`
 * (запись `__fixtures__/acp-basic.jsonl`) — оба транспорта идут ACP `session/new`.
 */
export const KIMI_REMOTE_MCP = { http: true, sse: true } as const;

/** Шаблон, которому не отвечает ни один инструмент: список разрешённых не пуст, когда MCP нет. */
export const KIMI_NONE_SENTINEL = 'mcp__agentdeck-none__*';

/**
 * Сеанс без инструментов (`tools: 'none'`, вопрос «ask», s10 p10): раздел `[tools]` config.toml
 * Kimi 2.4.1 (`ToolsConfigSchema {enabled, disabled}`, сборка): непустой `enabled` — список
 * разрешённых, встроенный проходит только по точному имени, MCP — по шаблону `mcp__…`. В списке
 * только серверы MCP шага, поэтому ни один встроенный (и будущий) инструмент не активен; пустой
 * `enabled` Kimi считает «не задан», отсюда шаблон-заглушка.
 */
export function kimiToolsNone(spec: SessionSpec): string {
  const servers = carriedMcp(spec).map(([name]) => `mcp__${name}__*`);
  const enabled = servers.length > 0 ? servers : [KIMI_NONE_SENTINEL];
  return `\n[tools]\nenabled = [${enabled.map(toml).join(', ')}]\n`;
}

export function planKimi(
  spec: SessionSpec,
  _binding: EndpointBinding | null,
  _layer: LayerRun,
): SdkLaunchPlan {
  const economy = kimiEconomy(spec);
  const none = spec.tools === 'none' ? kimiToolsNone(spec) : '';
  return {
    args: ['acp'],
    env: { KIMI_CODE_HOME: join(spec.dir, HOME) },
    files: {
      // Таблица рычага — после ключей верхнего уровня и `[[hooks]]` файла.
      [KIMI_FILES.config]: `${kimiConfigFile(spec.coreHook as string)}${economy.toml}${none}`,
    },
    ...(economy.lost.length > 0 ? { layerLosses: economy.lost } : {}),
  };
}

/** Режим и модель Kimi из ответа `session/new`: иные — хук или адрес сеанса не дошли. */
export function checkKimiSession(result: Record<string, unknown>): string | null {
  const modes = result.modes as { currentModeId?: unknown } | undefined;
  if (modes?.currentModeId !== KIMI_ACP_MODE) {
    return `kimi mode ${String(modes?.currentModeId)}, expected ${KIMI_ACP_MODE}`;
  }
  const options = Array.isArray(result.configOptions) ? (result.configOptions as unknown[]) : [];
  const model = options.find(
    (o): o is { id: string; currentValue?: unknown } =>
      typeof o === 'object' && o !== null && (o as { id?: unknown }).id === 'model',
  );
  return model?.currentValue === KIMI_ENV_MODEL
    ? null
    : `kimi model ${String(model?.currentValue)}, expected ${KIMI_ENV_MODEL} from KIMI_MODEL_*`;
}

export function createKimiAdapter(options: RpcAdapterOptions = {}): RpcAdapter {
  return createRpcAdapter(
    {
      id: kimiRunFacts.id,
      caps: KIMI_CAPS,
      command: kimiRunFacts.binary.command,
      cliLogin: false,
      readLayer: kimiReadLayer,
      mcpSource: kimiMcpSource,
      bindEndpoint: bindKimiEndpoint,
      layer: kimiLayer,
      refuse: refuseKimi,
      plan: planKimi,
      // Флага без записи у ACP Kimi нет; сеансы — под своим KIMI_CODE_HOME сеанса.
      ephemeral: 'session-home',
      resume: kimiResume,
      ownsTranscript: kimiOwnsTranscript,
      transcriptPresent: kimiTranscriptPresent,
      toolsNone: true,
      dialectInput: ({ spec, permit }): AcpDialectData => ({
        cli: kimiRunFacts.id,
        cwd: spec.cwd,
        permit,
        mcpServers: acpMcpServers(spec, KIMI_REMOTE_MCP),
        ...(spec.resume ? { load: spec.resume.conversationId } : {}),
        ...(spec.endpoint ? { model: spec.endpoint.endpoint.model } : {}),
      }),
      dialect: (data) =>
        withAcpInput(
          createAcpDialect({
            ...data,
            mapPermission: mapKimiPermission,
            toolName: kimiToolName,
            checkSession: checkKimiSession,
          }),
          fillKimiInput,
        ),
      viewInput: acpViewInput,
      mapPermission: mapKimiPermission,
      permitCodec: ACP_PERMIT_CODEC,
    },
    options,
  );
}
