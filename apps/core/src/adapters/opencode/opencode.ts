import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
import type { EnvRunChannel } from '@agentdeck/providers/types';
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
import { READ_ONLY_DENIED } from '../read-only.ts';
import { createAcpDialect, type AcpDialectData } from '../rpc-stdio/acp.ts';
import { carriedMcp, isRemoteMcp } from '../mcp-carry.ts';
import { economyRefused, withLosses } from '../economy-carry.ts';
import { opencodeMcpSource } from './mcp-source.ts';
import {
  createRpcAdapter,
  type RpcAdapter,
  type RpcAdapterOptions,
} from '../rpc-stdio/rpc-adapter.ts';
import type { SdkLaunchPlan } from '../sdk-stream/sdk-adapter.ts';
import { xdgConfigHome, xdgDataHome } from '../../platform/user-dirs.ts';
import { mapOpencodePermission, OPENCODE_PERMIT_CODEC, opencodeToolName } from './permission.ts';
import { opencodePluginSource } from './plugin.ts';

/**
 * Переходник opencode (1.18) поверх `opencode acp` — ACP по stdio. Дома opencode у сеанса свои
 * (`XDG_CONFIG/DATA/CACHE/STATE_HOME` под `<сеанс>/opencode-home`), конфиг — файл сеанса
 * (`OPENCODE_CONFIG`): плагин с хуком ядра и правила `permission`. Адрес модели — строкой конфига
 * (`OPENCODE_CONFIG_CONTENT`, построитель фактов запуска). Конфиг репозитория, слой Claude Code и
 * внешние навыки выключены переменными opencode; `OPENCODE_PURE` (без плагинов) снят.
 *
 * Возможности — только доказанные пробой 02.11 на stub-model: хук до вызова (отказ держится при
 * `permission` по умолчанию, ask, allow и deny), поток текста, ход под своим запросом, серверы MCP
 * шага ключом `mcp` конфига сеанса (серверы человека и `opencode.json` репозитория не стартуют —
 * s10 p6).
 */

const HOME = 'opencode-home';
const KEY_HOME = (spec: SessionSpec): string => join(spec.dir, HOME);

export const OPENCODE_FILES = {
  config: `${HOME}/opencode.json`,
  plugin: `${HOME}/agentdeck-core-hook.mjs`,
} as const;

export const OPENCODE_CHANNELS: AdapterChannelSummary[] = [
  // Конфиг строкой в окружении сеанса: по документации старше глобального и проектного.
  { via: 'env', dialect: 'openai-chat', perSession: true },
];

export const OPENCODE_CAPS: AdapterCaps = {
  resume: false,
  mcp: true,
  strictMcp: true,
  permissionTool: false,
  // Правила `permission` пишутся (запись/оболочка в сеансе только чтения), но оверлея путей нет.
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
  login: opencodeRunFacts.login,
  channels: OPENCODE_CHANNELS,
  windowEvent: false,
  limitsChannel: null,
  // Потерю входа (этап 12, P170) не называет: текста и чтения входа в наборе соответствия нет.
  loginLost: false,
};

export function bindOpencodeEndpoint(
  channel: AdapterChannelSummary,
  endpoint: BoundEndpoint,
): BindOutcome {
  if (channel.dialect !== 'openai-chat' || endpoint.dialect !== 'openai-chat') {
    return { ok: false, code: 'no_channel' };
  }
  const build = opencodeRunFacts.channels.find(
    (c): c is EnvRunChannel => c.via === 'env' && c.form === 'run' && c.dialect === 'openai-chat',
  )?.build;
  if (!build) return { ok: false, code: 'no_channel' };
  const env = build({
    baseUrl: `${endpoint.baseUrl.replace(/\/+$/, '')}/v1`,
    model: endpoint.model,
    key: endpoint.key,
  });
  if (!env.OPENCODE_CONFIG_CONTENT) return { ok: false, code: 'no_channel' };
  const binding: EndpointBinding = { env, argv: [], files: {} };
  return { ok: true, binding };
}

/** Каталоги opencode человека: вход (`auth.json`) и конфиг судья не даёт читать. */
export function opencodeReadLayer(pin: Record<string, string>): ReadLayer {
  const data = xdgDataHome(pin);
  const config = xdgConfigHome(pin);
  return {
    dirs: [],
    credentials: [join(data, 'opencode', 'auth.json'), join(config, 'opencode')],
  };
}

export function opencodeLayer(spec: SessionSpec): LayerRun {
  const asked = spec.layer.hooks;
  return {
    asked,
    ran: 'off',
    repoLayer: false,
    trust: 'none',
    detail:
      'opencode: per-session XDG homes and config, project config, Claude Code layer and external skills off',
    ...(asked === 'off'
      ? {}
      : { losses: [`hooks ${asked} -> off: opencode has no layer control`] }),
  };
}

export function refuseOpencode(spec: SessionSpec): string | null {
  if (!spec.coreHook) {
    return 'no core hook: the session would run without the core PreToolUse hook';
  }
  if (!spec.endpoint) {
    // Вход opencode — `auth.json` в доме данных человека: сеанс его не читает.
    return 'opencode runs only on a routed endpoint: its own login lives in the human data home';
  }
  if (spec.resume) return 'opencode adapter does not resume a conversation';
  return null;
}

const readOnly = (spec: SessionSpec): boolean =>
  READ_ONLY_DENIED.every((tool) => spec.deny.tools.includes(tool));

/**
 * Правила `permission`: запись и оболочка — вопрос (его решает судья ядра), в сеансе только
 * чтения — запрет (инструмента у модели нет). Хук ядра стоит при любых правилах.
 */
export function opencodePermission(spec: SessionSpec): Record<string, string> {
  // Без инструментов (`tools: 'none'`, вопрос «ask», s10 p10): `*` — запрет каждому инструменту,
  // и opencode снимает запрещённый из запроса модели (проба 1.18.35, 02.11: по умолчанию 10
  // встроенных, с `*: deny` — ни одного). Последнее совпадение главнее — серверы MCP шага
  // (`<сервер>_<инструмент>`) открыты после запрета: они — инструменты шага, не встроенные.
  if (spec.tools === 'none') {
    return {
      '*': 'deny',
      ...Object.fromEntries(carriedMcp(spec).map(([name]) => [`${name}_*`, 'allow'])),
    };
  }
  const ro = readOnly(spec);
  return {
    edit: ro ? 'deny' : 'ask',
    bash: ro ? 'deny' : 'ask',
    webfetch: 'ask',
    external_directory: 'ask',
  };
}

export function planOpencode(
  spec: SessionSpec,
  _binding: EndpointBinding | null,
  _layer: LayerRun,
): SdkLaunchPlan {
  const home = KEY_HOME(spec);
  const config = {
    $schema: 'https://opencode.ai/config.json',
    plugin: [pathToFileURL(join(spec.dir, OPENCODE_FILES.plugin)).href],
    permission: opencodePermission(spec),
    autoupdate: false,
    share: 'disabled',
    mcp: opencodeMcp(spec),
  };
  return {
    args: ['acp'],
    env: {
      OPENCODE_CONFIG: join(spec.dir, OPENCODE_FILES.config),
      OPENCODE_CONFIG_DIR: join(home, 'config', 'opencode'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_STATE_HOME: join(home, 'state'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_SHARE: '1',
      // Режим без внешних плагинов снял бы хук ядра: значение человека перебито явным «нет»
      // (пустую строку opencode 1.18 отвергает ошибкой схемы и не стартует, проба 02.11).
      OPENCODE_PURE: 'false',
    },
    files: {
      [OPENCODE_FILES.config]: JSON.stringify(config, null, 2),
      [OPENCODE_FILES.plugin]: opencodePluginSource(spec.coreHook as string),
    },
    // Схема opencode.ai/config.json: `compaction` — только вкл/выкл, порога, предела ответа
    // инструмента и срока кэша нет.
    ...withLosses(economyRefused(spec, 'opencode config has no key for it').lost),
  };
}

/**
 * Серверы MCP шага — ключом `mcp` конфига сеанса (`type: local`, команда массивом, `environment`):
 * проектный конфиг выключен (`OPENCODE_DISABLE_PROJECT_CONFIG`), дом свой — иных серверов нет.
 */
export function opencodeMcp(spec: SessionSpec): Record<string, unknown> {
  return Object.fromEntries(
    carriedMcp(spec).map(([name, entry]) => [
      name,
      isRemoteMcp(entry)
        ? // Удалённый (s10 p8): `type: remote` + `headers`; транспорт CLI выбирает сам (streamable
          // HTTP, затем SSE — в сборке 1.18 оба клиента). `oauth: false` — без входа по браузеру.
          {
            type: 'remote',
            url: entry.url,
            headers: entry.headers ?? {},
            oauth: false,
            enabled: true,
          }
        : {
            type: 'local',
            command: [entry.command, ...entry.args],
            ...(entry.env ? { environment: entry.env } : {}),
            enabled: true,
          },
    ]),
  );
}

export function createOpencodeAdapter(options: RpcAdapterOptions = {}): RpcAdapter {
  return createRpcAdapter(
    {
      id: opencodeRunFacts.id,
      caps: OPENCODE_CAPS,
      command: opencodeRunFacts.binary.command,
      // Вход opencode — в доме данных человека, сеанс его не читает: маршрута входа нет.
      cliLogin: false,
      readLayer: opencodeReadLayer,
      mcpSource: opencodeMcpSource,
      bindEndpoint: bindOpencodeEndpoint,
      layer: opencodeLayer,
      refuse: refuseOpencode,
      plan: planOpencode,
      // Флага без записи у ACP opencode нет; хранилище — под своими XDG_*_HOME сеанса.
      ephemeral: 'session-home',
      toolsNone: true,
      dialectInput: ({ spec, permit }): AcpDialectData => ({
        cli: opencodeRunFacts.id,
        cwd: spec.cwd,
        permit,
        ...(spec.endpoint ? { model: spec.endpoint.endpoint.model } : {}),
      }),
      dialect: (data) =>
        createAcpDialect({
          ...data,
          mapPermission: mapOpencodePermission,
          toolName: opencodeToolName,
        }),
      mapPermission: mapOpencodePermission,
      permitCodec: OPENCODE_PERMIT_CODEC,
    },
    options,
  );
}
