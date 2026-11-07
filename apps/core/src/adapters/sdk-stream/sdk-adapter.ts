import { cpSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  FROM_HUMAN_LINE,
  PLATFORM_MARKER,
  type SendOrigin,
} from '@agentdeck/contracts/core/user-layer';
import { dirname, join } from 'node:path';
import { attachSession, type AttachOutcome } from '../../session-host/client.ts';
import type { Identity } from '../../session-host/protocol.ts';
import { launchCli } from '../launcher/launch.ts';
import { stopSession } from '../launcher/session-io.ts';
import type { SpawnedFacts, StopMode, StopOutcome } from '../launcher/launcher.types.ts';
import { SdkNormaliser, type SdkRule } from './normalise.ts';
import type {
  AdapterCaps,
  AdapterChannelSummary,
  AdapterErrorCode,
  AdapterEvent,
  BindOutcome,
  BoundEndpoint,
  CliAdapter,
  EndpointBinding,
  LayerRun,
  LocalLimits,
  PermissionAsk,
  ReadLayer,
  RawToolCall,
  SessionHandle,
  SessionSpec,
  TurnUsage,
} from '../adapter.types.ts';
import { withPlatformDeny } from '../deny-overlay.ts';
import { resolveLayer, type LayerPolicy } from './layer-run.ts';
import { SDK_PERMIT_CODEC } from './permit-codec.ts';
import { SdkSession } from './session.ts';

/**
 * Общий каркас переходника для CLI, говорящих `stream-json` формата SDK: запуск через
 * запускающего и хост сессии, насос событий, отправка, остановка, использование. CLI-модуль
 * приносит только своё — возможности, привязку адреса, argv/окружение/файлы и правила разбора.
 */

export interface SdkLaunchPlan {
  args: string[];
  env: Record<string, string>;
  /** Файлы сеанса: путь относительно каталога сеанса → текст. */
  files: Record<string, string>;
  /** Что план добавил к слою на деле (F-86: сколько запретов репозитория дошло, какие сняты). */
  layerDetail?: string;
  /** Потери частей слоя человека (G-b) — в `LayerRun.losses` запуска. */
  layerLosses?: string[];
  /** Копии в каталог сеанса (каталог или файл → путь относительно каталога сеанса). */
  copies?: { from: string; to: string }[];
}

/**
 * Метка платформы первой строкой текста в сессию (06:119, P37, G2): хук человека отличает голос
 * платформы от человека; слова человека — второй строкой `agentdeck-from: human`. Уже меченый
 * текст не метится второй раз.
 */
export function markText(text: string, origin: SendOrigin = 'platform'): string {
  const head =
    origin === 'human'
      ? `${PLATFORM_MARKER}
${FROM_HUMAN_LINE}
`
      : `${PLATFORM_MARKER}
`;
  return text.startsWith(head) ? text : `${head}${text}`;
}

export interface SdkAdapterDef {
  id: string;
  caps: AdapterCaps;
  /** Имя исполняемого файла (разрешает платформа) — из фактов запуска CLI. */
  command: string;
  /** Лестница уровня шага из фактов запуска CLI; нет — ранга модели не знаем. */
  ladder?: CliAdapter['ladder'];
  transcriptPresent?: CliAdapter['transcriptPresent'];
  ownsTranscript?: CliAdapter['ownsTranscript'];
  /** Серверы MCP человека в конфиге CLI (`CliAdapter.mcpSource`, P73). */
  mcpSource?: CliAdapter['mcpSource'];
  toolsNone?: true;
  /** Сеанс без следа (`CliAdapter.ephemeral`); план читает `spec.ephemeral` сам. */
  ephemeral?: CliAdapter['ephemeral'];
  userSourcesOnly?: true;
  sessionCarry?: CliAdapter['sessionCarry'];
  echo: boolean;
  bindEndpoint(
    channel: AdapterChannelSummary,
    endpoint: BoundEndpoint,
    limits?: LocalLimits,
  ): BindOutcome;
  /** Доверие к исходному репозиторию и режим недоверенной копии (F-86). */
  layer: LayerPolicy;
  /** Слой чтения CLI вне копии (F-87): каталоги и учётные файлы с окружением задачи. */
  readLayer(pin: Record<string, string>): ReadLayer;
  /** План — по слою на деле (`layer.ran`, `layer.repoLayer`), а не по запрошенному. */
  plan(spec: SessionSpec, binding: EndpointBinding | null, layer: LayerRun): SdkLaunchPlan;
  /**
   * CLI спрашивает о праве строкой протокола (`can_use_tool`), а не инструментом сервера:
   * отвечает ядро (`permit.request` → `answerPermit`), если сеанс назвал отвечающего, иначе
   * переходник отказывает сразу.
   */
  inBandPermit?: boolean;
  /** Управляющий `initialize` первой строкой stdin (режим SDK у CLI, где он нужен). */
  initialize?: Record<string, unknown>;
  /** Сеанс, который CLI исполнить честно не может (например, слой человека не отключается). */
  refuse?(spec: SessionSpec, layer: LayerRun): string | null;
  mapPermission(raw: RawToolCall): PermissionAsk;
  /** Код ядра по тексту ошибки CLI — строка потока или stderr при выходе. */
  classifyError?(text: string): AdapterErrorCode | null;
  /** Строка окна подписки (`caps.windowEvent: true`); нет — окно этого CLI `unknown`. */
  readWindow?: SdkRule['readWindow'];
  /** Как читать исход вызова из `tool_result` этого CLI (этап 8, F18); нет — без `outcome`. */
  outcome?: SdkRule['outcome'];
  /**
   * Строки задач потока этого CLI (этап 11, P148): субагенты и фон → `agent.*` / `bg.*`, и
   * переходник объявляет `backgroundFacts`. Нет — дерево агентов этого CLI пусто.
   */
  tasks?: SdkRule['tasks'];
  /**
   * Чтение отказов хуков человека для сеанса (G-e): по спеке и слою запуска (`null` — сеанс
   * прежнего ядра, спеки нет). Нет — CLI отказ хука не отличает, `hook.refused` не издаётся.
   */
  hookReader?(spec: SessionSpec | null, layer: LayerRun | null): SdkRule['hookRefusals'];
}

export interface SdkAdapterOptions {
  /** Другой исполняемый файл (подставной CLI набора соответствия). */
  command?: string;
  /**
   * Явный путь CLI из настройки ядра (`cliPaths`, F9), читается на КАЖДОМ запуске: правка
   * настройки действует со следующей сессии. `undefined` — пути нет, решает `command` / поиск.
   */
  commandOf?: () => string | undefined;
  extraDirs?: string[];
  pollMs?: number;
}

export interface SdkAdapter extends CliAdapter {
  /** Насос сессии (для проверок смещения и разговора). */
  session(handle: SessionHandle): SdkSession | undefined;
  /**
   * Сессия прежнего ядра (01 §Sessions at core death, P89): живой хост — прикрепление к нему
   * по каталогу из журнала, история потока восстанавливается первой; иначе — исход хоста как
   * есть (`exited`/`lost`/`unknown`), и `unknown` сессию не хоронит.
   */
  reattach(input: ReattachInput): Promise<ReattachOutcome>;
}

export interface ReattachInput {
  sessionId: string;
  dir: string;
  /** Личность хоста из `session.started`: хост с другой личностью — не эта сессия. */
  host: Identity;
  /** Что журнал помнит о запуске (`session.started`): остальное знал только прежний запуск. */
  spawned: Pick<SpawnedFacts, 'cwd' | 'argv'>;
  /** Сессия запускалась с отвечающим о праве (как `spec.permitServer` при запуске). */
  permitServer: boolean;
}

export type ReattachOutcome =
  | { state: 'live'; handle: SessionHandle; replayed: number; conversationId: string | null }
  | Exclude<AttachOutcome, { state: 'live' }>;

export function writeSessionFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  }
}

/**
 * Копии слоя (навыки, агенты) в каталог сеанса. Ссылки не переносятся: ссылка вела бы из копии
 * за её пределы, а копия — то, что ядро прочло и показало в описи.
 */
export function copySessionFiles(
  dir: string,
  copies: readonly { from: string; to: string }[],
): void {
  for (const copy of copies) {
    const target = join(dir, copy.to);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(copy.from, target, {
      recursive: true,
      filter: (source) => !lstatSync(source).isSymbolicLink(),
    });
  }
}

export function createSdkAdapter(def: SdkAdapterDef, options: SdkAdapterOptions = {}): SdkAdapter {
  const sessions = new Map<string, SdkSession>();
  const rule: SdkRule = {
    echo: def.echo,
    mapPermission: (raw: RawToolCall) => def.mapPermission(raw),
    ...(def.classifyError ? { classifyError: def.classifyError } : {}),
    ...(def.readWindow ? { readWindow: def.readWindow } : {}),
    ...(def.outcome ? { outcome: def.outcome } : {}),
    ...(def.tasks ? { tasks: def.tasks } : {}),
  };
  const ruleFor = (spec: SessionSpec | null, layer: LayerRun | null): SdkRule => {
    const hookRefusals = def.hookReader?.(spec, layer);
    return hookRefusals ? { ...rule, hookRefusals } : rule;
  };

  const need = (handle: SessionHandle): SdkSession => {
    const session = sessions.get(handle.sessionId);
    if (!session) throw new Error(`no session ${handle.sessionId} in adapter ${def.id}`);
    return session;
  };

  /**
   * Файл CLI сейчас: путь из настройки ядра (`cliPaths`, читается на каждом обращении), иначе
   * подставной, иначе имя из фактов запуска. Один для запуска сеанса и для `--version`: иначе
   * версию отвечал бы CLI из PATH, а сеанс шёл бы настроенным.
   */
  const commandNow = (): string => options.commandOf?.() ?? options.command ?? def.command;

  return {
    id: def.id,
    // Образ процесса CLI — его исполняемый файл из фактов запуска (A2-F02).
    images: [def.command],
    get versionCommand() {
      return commandNow();
    },
    ...(def.ladder ? { ladder: def.ladder } : {}),
    ...(def.transcriptPresent ? { transcriptPresent: def.transcriptPresent } : {}),
    ...(def.ownsTranscript ? { ownsTranscript: def.ownsTranscript } : {}),
    ...(def.mcpSource ? { mcpSource: def.mcpSource } : {}),
    ...(def.toolsNone ? { toolsNone: true as const } : {}),
    ...(def.ephemeral ? { ephemeral: def.ephemeral } : {}),
    ...(def.tasks ? { backgroundFacts: true as const } : {}),
    ...(def.userSourcesOnly ? { userSourcesOnly: true as const } : {}),
    ...(def.sessionCarry ? { sessionCarry: def.sessionCarry } : {}),
    caps: def.caps,
    readLayer: (pin) => def.readLayer(pin),
    inventory: (pin, cwd, repoLayer, session) => def.layer.inventory(pin, cwd, repoLayer, session),
    bindEndpoint: (channel, endpoint, limits) => def.bindEndpoint(channel, endpoint, limits),
    mapPermission: (raw) => def.mapPermission(raw),
    permitCodec: SDK_PERMIT_CODEC,

    async launch(stepSpec) {
      // Запреты платформы — в каждом сеансе, до отказа и плана: оверлей CLI видит полный набор.
      const spec: SessionSpec = {
        ...stepSpec,
        deny: withPlatformDeny(stepSpec.platform, stepSpec.deny, stepSpec.cwd),
      };
      // Слой на деле — до отказа и плана: недоверенная копия не идёт со слоем репозитория (F-86).
      const layer = await resolveLayer(spec, def.layer);
      const refused = def.refuse?.(spec, layer) ?? null;
      if (refused) return { ok: false, reason: refused };
      let binding: EndpointBinding | null = null;
      if (spec.endpoint) {
        const bound = def.bindEndpoint(spec.endpoint.channel, spec.endpoint.endpoint, spec.limits);
        if (!bound.ok) return { ok: false, reason: `endpoint refused: ${bound.code}` };
        binding = bound.binding;
      }
      // Бриф — первый текст ядра в сессию: метка платформы первой строкой (P37).
      const plan = def.plan({ ...spec, brief: markText(spec.brief) }, binding, layer);
      mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
      writeSessionFiles(spec.dir, { ...(binding?.files ?? {}), ...plan.files });
      if (plan.copies) copySessionFiles(spec.dir, plan.copies);
      const outcome = await launchCli({
        dir: spec.dir,
        sessionId: spec.sessionId,
        command: commandNow(),
        args: [...plan.args, ...(binding?.argv ?? [])],
        cwd: spec.cwd,
        env: {
          pin: spec.env.pin,
          // Переходник поверх сессии ядра: привязка адреса и свои флаги не перебиваются.
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
      sessions.set(
        spec.sessionId,
        new SdkSession(outcome.dir, ruleFor(spec, layer), {
          ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
          permit: def.inBandPermit && spec.permitServer ? 'core' : 'refuse',
          ...(def.initialize ? { initialize: def.initialize } : {}),
        }),
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

    send(handle, message, cmdId, origin, images) {
      // Картинки — только у CLI с доказанной подачей (`caps.images`): иначе отказ, не тихий пропуск.
      if (images && images.length > 0 && !def.caps.images) {
        return Promise.reject(new Error(`${def.id} does not take images`));
      }
      return need(handle).send(cmdId, markText(message, origin), images);
    },

    async stop(handle, mode: StopMode): Promise<StopOutcome> {
      // Насос сеанса отдаёт канал хоста остановке, иначе переподключением отнял бы его.
      await sessions.get(handle.sessionId)?.quiesce();
      return stopSession(handle.dir, mode);
    },

    answerPermit(handle, requestId, reply) {
      return need(handle).answerControl(requestId, reply);
    },

    usage(handle): TurnUsage[] {
      return need(handle).usage();
    },

    // Отдельный нормализатор на каждый повтор: вид сеанса читает журнал с начала, живой насос
    // сессии он не трогает (его ожидания и учёт — для ядра, не для показа).
    streamNormaliser: () => new SdkNormaliser(ruleFor(null, null)),

    session: (handle) => sessions.get(handle.sessionId),

    async reattach(input) {
      const got = await attachSession(input.dir);
      if (got.state !== 'live') return got;
      const { host, child } = got.record;
      if (host.pid !== input.host.pid || host.start !== input.host.start || !child) {
        got.session.close();
        return {
          state: 'unknown',
          reason: child ? 'host identity differs from the journal' : 'host without a CLI',
        };
      }
      sessions.get(input.sessionId)?.close();
      let session: SdkSession;
      try {
        session = new SdkSession(input.dir, ruleFor(null, null), {
          ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
          permit: def.inBandPermit && input.permitServer ? 'core' : 'refuse',
          ...(def.initialize ? { initialize: def.initialize } : {}),
          resume: true,
        });
      } catch (error) {
        // Запись ввода не прочитана: восстанавливать вслепую нельзя, хоронить — тоже (F25).
        got.session.close();
        return { state: 'unknown', reason: `core-io: ${String(error)}` };
      }
      session.adopt(got.session);
      sessions.set(input.sessionId, session);
      return {
        state: 'live',
        handle: {
          sessionId: input.sessionId,
          dir: input.dir,
          host,
          child,
          spawned: {
            ...input.spawned,
            file: '',
            found: '',
            kind: 'reattached',
            envNames: [],
          },
        },
        replayed: session.replayed,
        conversationId: session.conversationId,
      };
    },
  };
}
