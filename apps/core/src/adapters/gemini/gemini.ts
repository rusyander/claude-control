import { join } from 'node:path';
import { geminiRunFacts } from '@agentdeck/providers/gemini';
import type { EnvVarsChannel } from '@agentdeck/providers/types';
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
import { createAcpDialect, type AcpDialectData } from '../rpc-stdio/acp.ts';
import { carriedMcp } from '../mcp-carry.ts';
import { economyRefused, withLosses } from '../economy-carry.ts';
import {
  createRpcAdapter,
  type RpcAdapter,
  type RpcAdapterOptions,
} from '../rpc-stdio/rpc-adapter.ts';
import type { SdkLaunchPlan } from '../sdk-stream/sdk-adapter.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { fillGeminiInput, geminiToolName, mapGeminiPermission } from './permission.ts';
import { GEMINI_POLICY_FILE, geminiPolicyToml } from './policy.ts';
import {
  GEMINI_HOME_DIR,
  geminiOwnsTranscript,
  geminiResume,
  geminiTranscriptPresent,
} from './transcript.ts';

/**
 * Переходник Gemini CLI (0.66) поверх `gemini --acp` — ACP по stdio. Дом CLI у каждого сеанса
 * свой (`GEMINI_CLI_HOME` = `<сеанс>/gemini-home`: настройки, политики, вход), адрес модели —
 * окружением (`GOOGLE_GEMINI_BASE_URL`/`GEMINI_MODEL`/`GEMINI_API_KEY`) при
 * `security.auth.selectedType = gemini-api-key` в настройках сеанса.
 *
 * Защита ядра — оверлей запретов (`policy.ts`), не хук: `BeforeTool` под `--acp` Gemini не
 * вызывает (проба 02.11, бандл 0.66). Копия — недоверенная (`GEMINI_CLI_TRUST_WORKSPACE=false`):
 * настройки, политики и MCP репозитория не грузятся, а режимы `autoEdit`/`yolo` CLI отказывает
 * сам («Cannot enable privileged approval modes in an untrusted folder», проба 02.11). Режим —
 * `default`: вызов, который политика не закрыла, спрашивает право, ответ — у судьи ядра.
 *
 * Возможности — только доказанные пробой на stub-model: оверлей запретов (push закрыт в каждом
 * режиме), поток текста, ход под своим запросом, продолжение разговора (`transcript.ts`: копия
 * одного разговора в дом сеанса, ACP `session/load`). Хука, MCP, картинок, подагентов и управления
 * слоем нет (P121). MCP: серверы stdio Gemini запускает только в доверенной папке
 * («uses stdio transport but current folder is not trusted», бандл 0.66, s10 p6) — и те, что пришли
 * через ACP `session/new`; доверие же грузит настройки, политики и MCP репозитория. Серверы шага
 * названы потерей.
 */

const HOME = GEMINI_HOME_DIR;
/** Режим права Gemini: проверяется в ответе `session/new`, иной — запуск сорван. */
export const GEMINI_MODE = 'default';

export const GEMINI_FILES = {
  settings: `${HOME}/.gemini/settings.json`,
  policy: `${HOME}/.gemini/policies/${GEMINI_POLICY_FILE}`,
} as const;

export const GEMINI_CHANNELS: AdapterChannelSummary[] = [
  // Настройка входа пишется в дом сеанса, поэтому выбор человека (`selectedType`) не мешает.
  { via: 'env', dialect: 'google-genai', keyVar: 'GEMINI_API_KEY', perSession: true },
];

export const GEMINI_CAPS: AdapterCaps = {
  resume: true,
  mcp: false,
  strictMcp: false,
  permissionTool: false,
  denyOverlay: true,
  // `BeforeTool` под `--acp` не вызывается: хука ядра у Gemini нет.
  preToolHooks: false,
  layerControl: false,
  attribution: true,
  stream: true,
  effort: false,
  images: false,
  subagents: false,
  skillControl: false,
  subagentHooks: false,
  login: geminiRunFacts.login,
  channels: GEMINI_CHANNELS,
  windowEvent: false,
  limitsChannel: null,
};

const varsChannel = (): EnvVarsChannel | undefined =>
  geminiRunFacts.channels.find(
    (c): c is EnvVarsChannel =>
      c.via === 'env' && c.form === 'vars' && c.dialect === 'google-genai',
  );

/** Канал Gemini — переменные фактов запуска (`@agentdeck/providers/gemini`), адрес без пути. */
export function bindGeminiEndpoint(
  channel: AdapterChannelSummary,
  endpoint: BoundEndpoint,
): BindOutcome {
  if (channel.dialect !== 'google-genai' || endpoint.dialect !== 'google-genai') {
    return { ok: false, code: 'no_channel' };
  }
  const vars = varsChannel();
  if (!vars?.modelVar || !vars.keyVar) return { ok: false, code: 'no_channel' };
  const env: Record<string, string> = {
    [vars.baseUrlVar]: endpoint.baseUrl.replace(/\/+$/, ''),
    [vars.modelVar]: endpoint.model,
    [vars.keyVar]: endpoint.key,
  };
  const binding: EndpointBinding = { env, argv: [], files: {} };
  return { ok: true, binding };
}

/** Дом Gemini человека: вход Google, ключи MCP и `.env` судья не даёт читать. */
export function geminiReadLayer(pin: Record<string, string>): ReadLayer {
  const dir = join(pin.GEMINI_CLI_HOME || homeDir(pin), '.gemini');
  return {
    dirs: [],
    credentials: ['oauth_creds.json', 'google_accounts.json', 'mcp-oauth-tokens.json', '.env'].map(
      (name) => join(dir, name),
    ),
  };
}

export function geminiLayer(spec: SessionSpec): LayerRun {
  const asked = spec.layer.hooks;
  return {
    asked,
    ran: 'off',
    repoLayer: false,
    trust: 'none',
    detail:
      'gemini: per-session GEMINI_CLI_HOME, the human settings do not load; the copy is untrusted (GEMINI_CLI_TRUST_WORKSPACE=false), repo settings, policies and MCP do not load',
    ...(asked === 'off' ? {} : { losses: [`hooks ${asked} -> off: gemini has no layer control`] }),
  };
}

export function refuseGemini(spec: SessionSpec): string | null {
  if (!spec.endpoint) {
    // Свой вход Gemini (Google, ключ) живёт в доме человека: сеанс его не читает.
    return 'gemini runs only on a routed endpoint: its own login lives in the human gemini home';
  }
  return null;
}

/**
 * Почему MCP не переносится и доверенная папка не выход (s10 p7, опыт 02.11, бандл 0.66): прибить
 * ключи репозитория можно только старшим слоем — системными настройками
 * (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`). Но Gemini берёт этот файл, лишь если он и КАЖДЫЙ предок
 * принадлежат root и не пишутся группой/прочими (`checkPosixStatsSecurity`; Windows — ACL), иначе
 * молча пропускает («Skipping system settings file … insecure»). Ядро под пользователем такого
 * файла не создаст — и доверенная папка отдаёт репозиторию всё: его `tools.discoveryCommand`
 * исполнился уже на `initialize` (живой опыт в контейнере). Слой пользователя репозиторий
 * перекрывает (user < workspace). Сетевой сервер не обход (s10 p11): ACP `session/new` кладёт его
 * в настройки, но `startConfiguredMcpServers` в недоверенной папке выходит до выбора транспорта —
 * слушатель на петле не получил ни запроса, доверенный контроль получил. Потеря названа, оценка —
 * заново при смене версии (`gemini.trusted-folder.live.integration.test.ts`).
 */
export function planGemini(
  spec: SessionSpec,
  _binding: EndpointBinding | null,
  _layer: LayerRun,
): SdkLaunchPlan {
  // Запись сервера права — не потеря: вопрос о праве идёт строкой ACP.
  const lost = carriedMcp(spec).map(([name]) => name);
  return {
    args: ['--acp'],
    env: {
      GEMINI_CLI_HOME: join(spec.dir, HOME),
      GEMINI_CLI_TRUST_WORKSPACE: 'false',
    },
    files: {
      [GEMINI_FILES.settings]: JSON.stringify(
        { security: { auth: { selectedType: 'gemini-api-key' } } },
        null,
        2,
      ),
      [GEMINI_FILES.policy]: geminiPolicyToml(spec.deny),
    },
    ...withLosses([
      ...(lost.length > 0
        ? [
            `mcp servers not carried (gemini 0.66 starts no mcp server in an untrusted folder, stdio or remote, and the copy is untrusted): ${lost.join(', ')}`,
          ]
        : []),
      ...economyRefused(
        spec,
        'gemini reads it only from settings files, and a per-run system settings file must be admin-owned',
      ).lost,
    ]),
    layerDetail: `gemini deny policy: ${spec.deny.commands.length} commands, ${spec.deny.paths.length} paths, ${spec.deny.tools.length} tool classes`,
  };
}

/** Режим Gemini из ответа `session/new`: другой — оверлей и вопрос о праве не те, запуск сорван. */
export function checkGeminiSession(result: Record<string, unknown>): string | null {
  const modes = result.modes as { currentModeId?: unknown } | undefined;
  return modes?.currentModeId === GEMINI_MODE
    ? null
    : `gemini mode ${String(modes?.currentModeId)}, expected ${GEMINI_MODE}`;
}

export function createGeminiAdapter(options: RpcAdapterOptions = {}): RpcAdapter {
  return createRpcAdapter(
    {
      id: geminiRunFacts.id,
      caps: GEMINI_CAPS,
      command: geminiRunFacts.binary.command,
      cliLogin: false,
      readLayer: geminiReadLayer,
      bindEndpoint: bindGeminiEndpoint,
      layer: geminiLayer,
      refuse: refuseGemini,
      plan: planGemini,
      resume: geminiResume,
      ownsTranscript: geminiOwnsTranscript,
      transcriptPresent: geminiTranscriptPresent,
      dialectInput: ({ spec, permit }): AcpDialectData => ({
        cli: geminiRunFacts.id,
        cwd: spec.cwd,
        permit,
        ...(spec.resume ? { load: spec.resume.conversationId } : {}),
        ...(spec.endpoint ? { model: spec.endpoint.endpoint.model } : {}),
      }),
      dialect: (data) =>
        withAcpInput(
          createAcpDialect({
            ...data,
            mapPermission: mapGeminiPermission,
            toolName: geminiToolName,
            checkSession: checkGeminiSession,
          }),
          fillGeminiInput,
        ),
      mapPermission: mapGeminiPermission,
      permitCodec: ACP_PERMIT_CODEC,
    },
    options,
  );
}
