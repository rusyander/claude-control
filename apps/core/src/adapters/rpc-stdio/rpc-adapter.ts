import { mkdirSync } from 'node:fs';
import { launchCli } from '../launcher/launch.ts';
import { stopSession } from '../launcher/session-io.ts';
import type { StopMode, StopOutcome } from '../launcher/launcher.types.ts';
import type {
  AdapterCaps,
  AdapterChannelSummary,
  AdapterEvent,
  BindOutcome,
  BoundEndpoint,
  CliAdapter,
  EndpointBinding,
  LayerRun,
  LocalLimits,
  PermissionAsk,
  PermitCodec,
  RawToolCall,
  ReadLayer,
  SessionHandle,
  SessionSpec,
  TurnUsage,
} from '../adapter.types.ts';
import { withPlatformDeny } from '../deny-overlay.ts';
import type { ResumeStage } from '../resume-store.types.ts';
import { markText, writeSessionFiles, type SdkLaunchPlan } from '../sdk-stream/sdk-adapter.ts';
import { RpcSession } from './rpc-session.ts';
import { createRpcNormaliser, readRpcViewInput, RPC_VIEW } from './rpc-view.ts';
import type { RpcDialect } from './rpc.types.ts';

/**
 * Каркас переходника для CLI, говорящего JSON-RPC по stdio (`codex app-server`, ACP): запуск
 * через запускающего и хост сессии, насос (`rpc-session.ts`), отправка, остановка. CLI-модуль
 * приносит возможности, привязку адреса, argv/окружение/файлы и диалект протокола. Прикрепиться к
 * живому процессу после смерти ядра нечем (рукопожатие JSON-RPC — в памяти CLI и ядра); продолжение
 * разговора — НОВЫЙ процесс: переходник с `resume` кладёт транскрипт в дом сеанса до запуска, а
 * диалект открывает его (`thread/resume`, ACP `session/load`). Нет `resume` — продолжение отказано.
 */

export interface RpcLaunchContext {
  /** Спека с меченым брифом (P37) и запретами платформы. */
  spec: SessionSpec;
  layer: LayerRun;
  /** Вопросы о праве решает ядро (`permit.request`); `refuse` — диалект отказывает сразу. */
  permit: 'core' | 'refuse';
}

/**
 * `I` — вход диалекта ДАННЫМИ (JSON): функции разбора диалект берёт у переходника сам. Тот же вход
 * строит диалект живого насоса и диалект вида сеанса (`rpc-view.ts`) — разбор один.
 */
export interface RpcAdapterDef<I extends object = object> {
  id: string;
  caps: AdapterCaps;
  command: string;
  ladder?: CliAdapter['ladder'];
  /** `false` — только маршрут с адресом модели, входа CLI нет (`CliAdapter.cliLogin`). */
  cliLogin?: false;
  readLayer(pin: Record<string, string>): ReadLayer;
  /** Серверы MCP человека в конфиге CLI (`CliAdapter.mcpSource`). */
  mcpSource?: CliAdapter['mcpSource'];
  bindEndpoint(
    channel: AdapterChannelSummary,
    endpoint: BoundEndpoint,
    limits?: LocalLimits,
  ): BindOutcome;
  /** Слой на деле: CLI JSON-RPC запускается со своим домом конфигурации, решает переходник. */
  layer(spec: SessionSpec): LayerRun;
  refuse?(spec: SessionSpec, layer: LayerRun): string | null;
  plan(spec: SessionSpec, binding: EndpointBinding | null, layer: LayerRun): SdkLaunchPlan;
  /**
   * Продолжение разговора (`spec.resume`): сверка id и корня транскрипта и его копия в дом сеанса.
   * Отказ — до запуска процесса. Нет метода — переходник разговор не продолжает (`caps.resume`
   * обязан быть `false`, это держит проверка соответствия).
   */
  resume?(spec: SessionSpec): ResumeStage;
  ownsTranscript?: CliAdapter['ownsTranscript'];
  transcriptPresent?: CliAdapter['transcriptPresent'];
  /** План снимает все встроенные инструменты CLI при `spec.tools === 'none'` (`CliAdapter.toolsNone`). */
  toolsNone?: true;
  /** Вход диалекта из запуска — только данные: он же ложится в `rpc-view.json` каталога сеанса. */
  dialectInput(context: RpcLaunchContext): I;
  /** Диалект по входу: один путь у живого насоса и у повтора вида сеанса. */
  dialect(input: I): RpcDialect;
  /**
   * Вход для диска: без значений, которые разбор не читает (бриф, env и заголовки серверов MCP).
   * Нет метода — вход пишется как есть.
   */
  viewInput?(input: I): I;
  mapPermission(raw: RawToolCall): PermissionAsk;
  permitCodec: PermitCodec;
}

export interface RpcAdapterOptions {
  command?: string;
  commandOf?: () => string | undefined;
  extraDirs?: string[];
  pollMs?: number;
}

export interface RpcAdapter extends CliAdapter {
  session(handle: SessionHandle): RpcSession | undefined;
}

export function createRpcAdapter<I extends object>(
  def: RpcAdapterDef<I>,
  options: RpcAdapterOptions = {},
): RpcAdapter {
  const sessions = new Map<string, RpcSession>();
  const need = (handle: SessionHandle): RpcSession => {
    const session = sessions.get(handle.sessionId);
    if (!session) throw new Error(`no session ${handle.sessionId} in adapter ${def.id}`);
    return session;
  };
  const commandNow = (): string => options.commandOf?.() ?? options.command ?? def.command;

  return {
    id: def.id,
    images: [def.command],
    get versionCommand() {
      return commandNow();
    },
    ...(def.ladder ? { ladder: def.ladder } : {}),
    ...(def.cliLogin === false ? { cliLogin: false as const } : {}),
    caps: def.caps,
    ...(def.ownsTranscript ? { ownsTranscript: def.ownsTranscript } : {}),
    ...(def.transcriptPresent ? { transcriptPresent: def.transcriptPresent } : {}),
    ...(def.toolsNone ? { toolsNone: true as const } : {}),
    readLayer: (pin) => def.readLayer(pin),
    ...(def.mcpSource ? { mcpSource: def.mcpSource } : {}),
    bindEndpoint: (channel, endpoint, limits) => def.bindEndpoint(channel, endpoint, limits),
    mapPermission: (raw) => def.mapPermission(raw),
    permitCodec: def.permitCodec,

    async launch(stepSpec) {
      // Запреты платформы — в каждом сеансе, до отказа и плана (как у каркаса SDK).
      const spec: SessionSpec = {
        ...stepSpec,
        deny: withPlatformDeny(stepSpec.platform, stepSpec.deny, stepSpec.cwd),
        brief: markText(stepSpec.brief),
      };
      const layer = def.layer(spec);
      const refused = def.refuse?.(spec, layer) ?? null;
      if (refused) return { ok: false, reason: refused };
      let resumed: ResumeStage | null = null;
      if (spec.resume) {
        // Разговор продолжает только переходник, который сам сверил транскрипт: иначе отказ, а не
        // тихий новый разговор под старым id.
        if (!def.resume)
          return { ok: false, reason: `${def.id} adapter does not resume a conversation` };
        resumed = def.resume(spec);
        if (!resumed.ok) return { ok: false, reason: resumed.reason };
      }
      let binding: EndpointBinding | null = null;
      if (spec.endpoint) {
        const bound = def.bindEndpoint(spec.endpoint.channel, spec.endpoint.endpoint, spec.limits);
        if (!bound.ok) return { ok: false, reason: `endpoint refused: ${bound.code}` };
        binding = bound.binding;
      }
      const plan = def.plan(spec, binding, layer);
      const input = def.dialectInput({
        spec,
        layer,
        permit: spec.permitServer ? 'core' : 'refuse',
      });
      mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
      // Вход диалекта — до запуска CLI: сеанс, у которого есть вывод, всегда читается видом.
      writeSessionFiles(spec.dir, {
        ...(binding?.files ?? {}),
        ...plan.files,
        [RPC_VIEW]: JSON.stringify(def.viewInput?.(input) ?? input),
      });
      if (resumed?.ok) {
        try {
          resumed.place();
        } catch (error) {
          return {
            ok: false,
            reason: `resume_unreadable: transcript copy failed: ${String(error)}`,
          };
        }
      }
      const outcome = await launchCli({
        dir: spec.dir,
        sessionId: spec.sessionId,
        command: commandNow(),
        args: [...plan.args, ...(binding?.argv ?? [])],
        cwd: spec.cwd,
        env: {
          pin: spec.env.pin,
          session: { ...(spec.env.session ?? {}), ...(binding?.env ?? {}), ...plan.env },
          ...(spec.env.nodeRequires ? { nodeRequires: spec.env.nodeRequires } : {}),
        },
        core: spec.core,
        ...(options.extraDirs ? { extraDirs: options.extraDirs } : {}),
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      const handle: SessionHandle = {
        sessionId: spec.sessionId,
        dir: outcome.dir,
        host: outcome.host,
        child: outcome.child,
        spawned: outcome.spawned,
      };
      const dialect = def.dialect(input);
      sessions.set(
        spec.sessionId,
        new RpcSession(
          outcome.dir,
          dialect,
          options.pollMs === undefined ? {} : { pollMs: options.pollMs },
        ),
      );
      const detail = [layer.detail, plan.layerDetail].filter(Boolean).join('; ');
      const losses = [...(layer.losses ?? []), ...(plan.layerLosses ?? [])];
      return {
        ok: true,
        handle,
        layer: {
          ...layer,
          ...(detail ? { detail } : {}),
          ...(losses.length > 0 ? { losses } : {}),
        },
      };
    },

    events(handle): AsyncIterable<AdapterEvent> {
      return need(handle).events();
    },

    send(handle, message, cmdId, origin) {
      return need(handle).send(cmdId, markText(message, origin));
    },

    async stop(handle, mode: StopMode): Promise<StopOutcome> {
      await sessions.get(handle.sessionId)?.quiesce();
      return stopSession(handle.dir, mode);
    },

    answerPermit(handle, requestId, reply) {
      return need(handle).answer(requestId, reply);
    },

    usage(handle): TurnUsage[] {
      return need(handle).usage();
    },

    // Свежий диалект из входа запуска на каждый повтор: живой насос сеанса вид не трогает.
    streamNormaliser: (dir) => createRpcNormaliser(def.dialect(readRpcViewInput<I>(dir))),

    session: (handle) => sessions.get(handle.sessionId),
  };
}
