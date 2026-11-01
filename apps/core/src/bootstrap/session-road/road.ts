import { join } from 'node:path';
import { PERMIT_MCP_SERVER, PERMIT_TOOL } from '@agentdeck/contracts/core/model-tools';
import type { SessionStateDoc, UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import type {
  AdapterChannelSummary,
  CompatDecision,
  CredentialKind,
  Dialect,
  Route,
  RouteEndpoint,
  RouteLease,
} from '@agentdeck/contracts/core/routes';
import type {
  AdapterRegistry,
  CliAdapter,
  LayerRun,
  PlatformDenyFacts,
  SessionHandle,
  SessionSpec,
} from '../../adapters/index.ts';
import { SESSION_TMP } from '../../adapters/launcher/index.ts';
import { sessionPermitDeny } from '../../adapters/deny-overlay.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { ActionFailed, runAction } from '../../conductor/outbox.ts';
import type { ReleaseDeps } from '../../conductor/services.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { CORE_PROCS_VAR } from '../../mcp/bridges.ts';
import { coreMcpServers } from '../../mcp/main.ts';
import { CAPTURE_SHIM } from '../../platform/capture-shim.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';
import { longForm } from '../../platform/paths.ts';
import { toolchainReadRoots } from '../../platform/toolchain-roots.ts';
import { buildReadScope } from '../../policy/permit/read-scope-build.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import type { SessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import { TREE_MARKER } from '../../session-host/host.ts';
import { PERMIT_SELF_TOOL, type SessionRuntime } from '../session-runtime.ts';
import { compat as judgeCompat } from '../../routes/compat/compat.ts';
import { modelRequired } from '../../routes/lease.ts';
import { compatInputs, compatRecord, type CompatCandidateRef } from './compat-gate.ts';
import { permitSourcesFor } from './permit-sources.ts';
import { captureRoadsSignal, scanEngines } from './capture-roads.ts';
import {
  coreHookCommand,
  installCaptureWrappers,
  installContainerWrappers,
  installStateWrapper,
  recorderCommand,
  WRAPPER_DIR,
} from './hook-file.ts';
import {
  HOOKS_LOG,
  journalLayerObserved,
  journalLayerStart,
  panelTrusted,
} from './layer-journal.ts';
import { createSessionLayerBook } from './layer-facts.ts';
import {
  hopPolicy,
  hopReason,
  linkHop,
  unlinkHop,
  type HopLinked,
  type RoadHops,
} from './hop-link.ts';
import type { SessionKeyBook } from '../session-keys.ts';
import { sessionPath, type LoginPathReader } from './launch-env.ts';
import { createLeaseBook, journalLease } from './lease-release.ts';
import { sessionMcpList, strictServers, withMcpDeny } from './mcp-list.ts';
import type { McpList } from '../../context/mcp/index.ts';
import {
  ownCopiesOf,
  protectedAtEnd,
  protectedBefore,
  type ProtectedHeld,
} from './protected-step.ts';
import { readAllowFor } from './read-allow.ts';
import { journalRecorder } from './recorder.ts';
import { sourceRepoOf } from './source-repo.ts';
import {
  readBaseline,
  REAL_READERS,
  scanAfterStop,
  scanBeforeStop,
  takeBaseline,
  type Baseline,
  type ResourceReaders,
  type ScanContext,
} from './resources.ts';
import type {
  PrepareOutcome,
  Prepared,
  RoadAttach,
  RoadSession,
  RoadStart,
  SessionEnd,
  TaskRelease,
} from './road.types.ts';
import { releaseTaskEnd } from './task-release.ts';

/**
 * ОДНА дорога сессии ядра (03 §Launcher, 06 §Session permissions, 11 R:PR-05, 01 §Resources):
 * совместимость → аренда и адрес маршрута → токен → окружение (PATH оболочки входа, файл procs)
 * → хук ядра, обёртки PATH, оверлей запретов → запуск (действие outbox `process-start`) →
 * прикрепление к рантайму сессий (вопрос о праве — ответ ядра, не 503) → на остановке поиск
 * ресурсов и сравнение защищённых корней со снимком до шага → в конце задачи снятие находок,
 * контейнеров сервисов и аренд с чтением назад. Отказ любого звена до запуска — отказ
 * запуска с причиной, а не сессия без звена.
 */

export const DEFAULT_NODE_ARGV: readonly string[] = [
  process.execPath,
  '--experimental-strip-types',
  '--no-warnings',
];

/**
 * Ключ на адрес без ссылки на ключ (заглушка, своя модель на loopback): CLI требует непустое
 * значение, сервер его не проверяет. Не секрет и не похоже на него.
 */
export const NO_KEY = 'agentdeck-no-key';

type Note = (event: string, data: Record<string, unknown>) => void;

export interface RoadDeps {
  url: string;
  layout: CoreHomeLayout;
  sessionTokens: SessionTokens;
  routes: RouteRegistry;
  adapters: AdapterRegistry;
  sessions: SessionRuntime;
  loginPath: LoginPathReader;
  note: Note;
  /** node ядра с флагами: им CLI запускает мосты MCP и хук. */
  nodeArgv?: readonly string[];
  os?: OsKind;
  readers?: ResourceReaders;
  /** Корни кешей и инструментов для области чтения; по умолчанию — факты платформы. */
  toolchainRoots?: (copyRoot: string) => string[];
  /** Копии живых задач — изменчивое для защищённых корней (их меняет их работа); нет — пусто. */
  liveCopies?: () => readonly string[];
  /** Реестр стендов: стенд ядра, снятый концом задачи, снимается и с наблюдения (A2r5-F04). */
  stands?: ReleaseDeps['stands'];
  /**
   * Хост звеньев (11 §Hop chain, G4): ключ из хранилища панели, перевод диалекта, шлюз контура,
   * маска политики. Нет — сеанс, которому нужно звено, отказывает с причиной.
   */
  hops?: RoadHops;
  /**
   * Книга ключей сеанса (P61): значение ключа `env`, прочитанное дорогой, уходит маске `known`
   * (`session-keys.ts`), даже под несекретным именем. Нет — дорога ключи не отмечает.
   */
  keys?: SessionKeyBook;
  /**
   * Версия CLI сеанса для `session.started` — тот же читатель, что у замера базы (`--version`
   * один раз на «команда × PATH»). Нет — в журнале `not-probed`; не прочиталась — `unread`.
   */
  cliVersion?: (p: Prepared) => Promise<string | null>;
  /**
   * Снимок `agentdeck state` на запуск (этап 7, G8): ложится в `state.json` сессии запасным путём
   * команды, когда ядро недоступно. Нет — в файле только задача, шаг и вид шага, как прежде.
   */
  sessionState?: (task: LiveTask, start: RoadStart) => SessionStateDoc | undefined;
}

export interface LaunchOptions {
  /** Сразу после эффекта запуска, до `action.done` (точка смерти сквозного прогона). */
  afterEffect?: () => void;
}

export type LaunchResult =
  { ok: true; handle: SessionHandle; layer: LayerRun } | { ok: false; reason: string };

export interface SessionRoad {
  prepare(start: RoadStart): Promise<PrepareOutcome>;
  launch(prepared: Prepared, options?: LaunchOptions): Promise<LaunchResult>;
  /**
   * `session.started` (со слоем, с которым сеанс запущен на деле) + переход `spawned`: журнал
   * знает сессию до её прикрепления.
   */
  started(prepared: Prepared, handle: SessionHandle, layer: LayerRun): void;
  attach(input: RoadAttach): RoadSession;
  /** Факты права сессии без запуска (сессия прежнего ядра, прикреплённая заново). */
  contextFor(start: RoadStart): PermitContext;
  /**
   * PATH, с которым сессия запустит CLI (каталоги `prefix` + PATH логин-шелла, без обёрток): по нему
   * же предпроверка ищет CLI — иначе проба и запуск видят разные каталоги.
   */
  searchPath(prefix?: readonly string[]): Promise<string>;
  releaseTask(task: LiveTask): Promise<TaskRelease>;
  /** Опись слоя человека у сеанса (кран слоя: кандидаты безымянного отказа); нет — `null`. */
  layerInventory(sessionId: string): UserLayerInventory | null;
}

const OPEN = new Set(['starting', 'live', 'quiet']);

/** Подготовка после взятой аренды: каждый её отказ и бросок идут через `refuse`. */
interface Leased {
  start: RoadStart;
  adapter: CliAdapter;
  route: Route;
  lease: RouteLease;
  compat: Extract<CompatDecision, { kind: 'direct' | 'via-gateway' }>;
  refuse: (reason: string) => Promise<PrepareOutcome>;
}

function isAdapterChannel(channel: Leased['compat']['channel']): channel is AdapterChannelSummary {
  return channel.via !== 'login';
}

/** Диалект аренды: при переводе звеном — диалект ВЕРХА (`to`), не CLI; вход CLI — без диалекта. */
function leaseDialectOf(compat: Leased['compat']): { dialect?: Dialect } {
  if (compat.kind === 'via-gateway') return { dialect: compat.to };
  return isAdapterChannel(compat.channel) ? { dialect: compat.channel.dialect } : {};
}

function keyOf(
  endpoint: RouteEndpoint,
  pin: Record<string, string>,
): { key: string; kind: CredentialKind } | { refused: string } {
  const ref = endpoint.keyRef;
  if (ref === null) return { key: NO_KEY, kind: 'none' };
  if (ref.kind === 'env') {
    const found = Object.entries(pin).find(([name]) => name === ref.name)?.[1];
    if (!found) return { refused: `key variable ${ref.name} not in the task pin` };
    return { key: found, kind: 'env' };
  }
  // Ключ хранилища панели и вставка звеном идут ТОЛЬКО через звено (`hop-link.ts`, G5): мимо
  // звена ядро ключ не читает — отказ с причиной, а не сеанс без ключа.
  return { refused: `key source ${ref.kind} goes only through the hop` };
}

export function createSessionRoad(deps: RoadDeps): SessionRoad {
  const os = deps.os ?? currentOs();
  const nodeArgv = deps.nodeArgv ?? DEFAULT_NODE_ARGV;
  const readers = deps.readers ?? REAL_READERS;
  const leases = createLeaseBook();
  const toolchain = deps.toolchainRoots ?? ((copyRoot: string) => toolchainReadRoots({ copyRoot }));
  const liveCopies = deps.liveCopies ?? (() => []);
  // Снимки до запуска — в памяти дороги и в доме ядра, никогда из каталога сессии (её пишет
  // сама сессия, ревью B2r4-F02/F04); дом ядра — для сессии, прикреплённой после перезапуска.
  const stateDir = join(deps.layout.root, 'session-state');
  const held = new Map<string, { baseline: Baseline; protected: ProtectedHeld }>();
  // Метки сеансов у звена: снимаются на остановке сеанса, на отказе подготовки и запуска.
  const linked = new Map<string, Pick<HopLinked, 'handle' | 'tag'>>();
  const unlink = async (sessionId: string): Promise<void> => {
    const link = linked.get(sessionId);
    if (!link) return;
    linked.delete(sessionId);
    await unlinkHop(link, deps.note);
  };
  // Факты слоя сеансов: режим навыков, подагенты, опись — судье права и крану слоя.
  const layers = createSessionLayerBook();
  const platform: PlatformDenyFacts = {
    coreHome: deps.layout.root,
    tokenFiles: [deps.layout.token],
  };

  /** Исходный репозиторий шага: названный запуском, иначе из `task.created` (F-86). */
  const sourceOf = (start: RoadStart): string | undefined =>
    start.sourceRepo ?? start.trust?.sourceRepo ?? sourceRepoOf(start.task, start.stepId);

  /** Строгий список MCP шага (`mcp-list.ts`): один для оверлея CLI, судьи права и ключа базы. */
  const mcpOf = (start: RoadStart): McpList | null => sessionMcpList(start.stepKind, start.routeId);

  const contextFor = (start: RoadStart): PermitContext => {
    const { task } = start;
    // Судья решает по тем же запретам, что оверлей CLI получил при запуске (F-11): платформа,
    // `.git` и настройки CLI копии, запреты списка MCP вида, плюс сам инструмент права.
    const stepDeny = withMcpDeny(start.deny, mcpOf(start));
    const permitDeny = sessionPermitDeny(
      platform,
      { ...stepDeny, mcpTools: [...stepDeny.mcpTools, PERMIT_SELF_TOOL] },
      start.cwd,
    );
    const allow = readAllowFor(deps.layout.config, sourceOf(start));
    const signal = (signal: string, severity: 'info' | 'warn', subject: string, detail: string) =>
      task.append({
        kind: 'signal',
        actor: 'core',
        stepId: start.stepId,
        sessionId: start.sessionId,
        data: { signal, severity, subject, detail },
      });
    if (allow.problem) signal('read-allow-unread', 'warn', deps.layout.config, allow.problem);
    // Слой CLI (каталоги только для чтения, файлы учётных данных) — факт переходника с пином
    // задачи; переходника нет — пусто, и эти каталоги вне копии отказываются.
    const adapter = deps.adapters.get(start.adapterId);
    const built = buildReadScope({
      copyRoot: start.cwd,
      sessionTemp: join(longForm(start.dir, os), SESSION_TMP),
      layer: adapter ? adapter.readLayer(start.pin) : { dirs: [], credentials: [] },
      toolchainRoots: toolchain(start.cwd),
      humanAllow: allow.entries,
    });
    for (const refused of built.refused) {
      signal('read-scope-refused', 'info', refused.entry, refused.reason);
    }
    // Пункты человека 3 и 5 (P130): `grantRequired` конфига ядра, гранты задачи, источники адреса.
    const human = permitSourcesFor(task, {
      stepId: start.stepId,
      copyRoot: start.cwd,
      sourceRepo: sourceOf(start),
      config: deps.layout.config,
    });
    for (const p of human.problems) signal('permit-sources-unread', 'warn', p.subject, p.why);
    return {
      copyRoot: start.cwd,
      ownedPaths: start.ownedPaths ?? [],
      deny: permitDeny.deny,
      platformPaths: permitDeny.platformPaths,
      endpointSources: human.endpointSources,
      grantRequired: human.grantRequired,
      grants: human.grants,
      readScope: built.scope,
      ...layers.context(start, adapter),
    };
  };

  async function prepare(start: RoadStart): Promise<PrepareOutcome> {
    const { task } = start;
    const adapter: CliAdapter | undefined = deps.adapters.get(start.adapterId);
    if (!adapter) return { ok: false, reason: `adapter ${start.adapterId} not registered` };
    const route: Route | undefined = deps.routes.get(start.routeId);
    if (!route) return { ok: false, reason: `route ${start.routeId} not registered` };
    const recorder = journalRecorder(task);
    // Модель по умолчанию CLI годится только входу самого CLI: маршруту с адресом нужна модель
    // в адресе (переменная модели CLI), а угадывать её дорога не будет — отказ до всего.
    const needs = modelRequired(route, start.model);
    if (needs) return { ok: false, reason: needs };

    // ── совместимость: до аренды, токена, каталога и процесса ──
    // Запасные тройки суда `tier` (P110): незарегистрированная не кандидат — её фактов нет.
    const candidates: CompatCandidateRef[] = [];
    for (const alt of start.alternatives ?? []) {
      const a = deps.adapters.get(alt.adapterId);
      const r = deps.routes.get(alt.routeId);
      if (a && r) candidates.push({ adapter: a, route: r, model: alt.model });
    }
    const inputs = await compatInputs(
      task,
      adapter,
      route,
      start.model,
      candidates,
      hopPolicy(deps.hops, route.id),
    );
    const compat = judgeCompat(
      inputs.adapter,
      inputs.facts.route,
      inputs.facts.model,
      inputs.policy,
    );
    recorder.decision(compatRecord(compat, inputs));
    if (compat.kind === 'refused') {
      return { ok: false, reason: `compat refused: ${compat.code}`, compat };
    }
    // `via-gateway` — перевод диалекта звеном шлюза: метку регистрирует `afterLease` (`hop-link.ts`).

    // ── аренда ──
    const acquired = start.lease === undefined;
    const lease: RouteLease =
      start.lease ??
      (await route.acquire(
        {
          taskId: task.taskId,
          sessionId: start.sessionId,
          // `null` — модель выбирает CLI: её берёт только вход CLI, остальные отказывают сами.
          model: start.model,
          ...leaseDialectOf(compat),
        },
        recorder,
      ));
    // Взятая аренда — в книгу дороги и строкой журнала до первого отказа: запуск, который так и
    // не состоялся, снимается в конце задачи, и после перезапуска ядра тоже (ревью B2r4-F06).
    leases.remember(task.taskId, { routeId: route.id, lease });
    if (acquired) journalLease(task, start.sessionId, { routeId: route.id, lease });
    const refuse = async (reason: string): Promise<PrepareOutcome> => {
      held.delete(start.sessionId);
      await unlink(start.sessionId);
      if (acquired) {
        await route.release(lease, recorder).catch(() => undefined);
        leases.forget(task.taskId, lease.leaseId);
      }
      return { ok: false, reason, compat };
    };
    // Бросок любого звена после аренды (снимки, обёртки, контекст) — отказ через `refuse`: аренда
    // снимается сразу, а не ждёт конца задачи (ревью B2r4-F05).
    try {
      return await afterLease({ start, adapter, route, lease, compat, refuse });
    } catch (error) {
      return refuse(`prepare failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function afterLease(leased: Leased): Promise<PrepareOutcome> {
    const { start, adapter, route, lease, compat, refuse } = leased;
    const { task } = start;
    const recorder = journalRecorder(task);
    const channel = compat.channel;
    // ── адрес маршрута ──
    let endpoint: SessionSpec['endpoint'];
    let credentialKind: CredentialKind = route.kind === 'cli-login' ? 'cli-store' : 'none';
    // Пин сеанса: через звено — без ключей и с адресом звена (`applyHopEnv`, P112).
    let pin = start.pin;
    let hops: Prepared['hops'] = [];
    if (isAdapterChannel(channel)) {
      // Сюда без модели не доходят (`modelRequired`); проверка — для типа и на случай нового пути.
      if (start.model === null) return refuse(modelRequired(route, null) ?? 'model required');
      const got = await route.endpoint(lease, recorder);
      if (!got) return refuse(`route ${route.id} gave no live endpoint`);
      const reason = hopReason(route, got, compat, deps.hops);
      if (reason !== null) {
        // ── звено (G4): CLI говорит со звеном своим диалектом, ключ подставляет только звено ──
        const link = await linkHop({
          hops: deps.hops,
          reason,
          sessionId: start.sessionId,
          route,
          endpoint: got,
          channel,
          compat,
          pin: start.pin,
        });
        if ('refused' in link) return refuse(link.refused);
        linked.set(start.sessionId, link);
        if (link.sessionKey)
          deps.keys?.record(start.sessionId, link.sessionKey.name, link.sessionKey.value);
        credentialKind = 'hop-injected';
        pin = link.pin;
        hops = link.hops;
        endpoint = {
          channel,
          endpoint: {
            baseUrl: link.baseUrl,
            dialect: channel.dialect,
            model: start.model,
            key: link.key,
          },
        };
      } else {
        const key = keyOf(got, start.pin);
        if ('refused' in key) return refuse(key.refused);
        // Ключ `env` уходит в окружение CLI — и маске `known`, каким бы ни было имя переменной.
        if (got.keyRef?.kind === 'env')
          deps.keys?.record(start.sessionId, got.keyRef.name, key.key);
        credentialKind = key.kind;
        endpoint = {
          channel,
          endpoint: {
            baseUrl: got.baseUrl,
            dialect: got.dialect,
            model: start.model,
            key: key.key,
          },
        };
      }
    }

    // ── окружение ──
    const loginPath = await deps.loginPath();
    const wrapperDir = join(start.dir, WRAPPER_DIR);
    const prefix = start.pathPrefix ?? [];

    // ── хук ядра и обёртки PATH (исполняемые, P105) ──
    const hook = coreHookCommand(start.dir, nodeArgv, os);
    if (!hook.ok) return refuse(hook.reason);
    // Запись хуков человека в `observe` (P87, G7): без неё переходник не исполнил бы ни одного
    // хука человека и назвал бы это потерей — дорога ставит её всегда, режим решит переходник.
    const hookRecorder = recorderCommand(start.dir, nodeArgv, os);
    if (!hookRecorder.ok) return refuse(hookRecorder.reason);
    const wrappers = installContainerWrappers({
      dir: start.dir,
      taskId: task.taskId,
      env: { ...pin, PATH: sessionPath('', prefix, loginPath) },
      os,
      nodeArgv,
    });
    if (wrappers.failed.length > 0) {
      deps.note('session.wrappers.failed', {
        taskId: task.taskId,
        sessionId: start.sessionId,
        failed: wrappers.failed,
      });
    }
    // `agentdeck state` для хуков человека (03:82, G8): обёртка в том же `bin` сессии. Не встала —
    // сеанс идёт (это удобство автора хука, не граница), причина — в журнал ядра, не молчание.
    const stateCommand = installStateWrapper({ dir: start.dir, os, nodeArgv });
    if (!stateCommand.ok) {
      deps.note('session.state-wrapper.failed', {
        taskId: task.taskId,
        sessionId: start.sessionId,
        reason: stateCommand.reason,
      });
    }
    // Захват проверок (03 §Process capture): обёртки PATH над go/pytest/cargo … и прокладка
    // `--require` в NODE_OPTIONS CLI; какие дороги захвачены, а какие нет — сигналом в журнал.
    const capture = installCaptureWrappers({
      dir: start.dir,
      env: { ...pin, PATH: sessionPath('', prefix, loginPath) },
      os,
      nodeArgv,
    });
    task.append({
      kind: 'signal',
      actor: 'core',
      stepId: start.stepId,
      sessionId: start.sessionId,
      data: { signal: 'capture-roads', subject: start.sessionId, ...captureRoadsSignal(capture) },
    });
    const baseline = await takeBaseline(
      {
        task,
        sessionId: start.sessionId,
        stateDir,
        cwd: start.cwd,
        engines: scanEngines(wrappers.engines),
      },
      readers,
    );
    // Защищённые корни (P04): снимок до шага — сравнение на остановке сессии.
    const protectedHeld = await protectedBefore({
      task,
      sessionId: start.sessionId,
      stateDir,
      stepId: start.stepId,
      cwd: start.cwd,
      layer: adapter.readLayer(start.pin),
      ownCopies: ownCopiesOf(task),
    });
    held.set(start.sessionId, { baseline, protected: protectedHeld });

    const context = contextFor(start);
    // ── токен — последним звеном (ревью B2r4-F05): отзыва у токенов нет, а отказ после чеканки
    // оставил бы действующий токен сессии, которой не будет ──
    const token = deps.sessionTokens.mint({ taskId: task.taskId, sessionId: start.sessionId });
    const bridgeEnv = {
      AGENTDECK_CORE_URL: deps.url,
      AGENTDECK_SESSION_TOKEN: token,
      [CORE_PROCS_VAR]: deps.layout.procs,
    };
    const mcp = mcpOf(start);
    const mcpServers = Object.fromEntries(
      Object.entries(strictServers(coreMcpServers(nodeArgv), mcp)).map(([name, entry]) => [
        name,
        { ...entry, env: bridgeEnv },
      ]),
    );
    // Доверие — к ИСХОДНОМУ репозиторию (F-86): отметка панели — `config.trustedRepos` (03:44);
    // её нет — слой репозитория открывает только запись доверия самого CLI.
    const sourceRepo = sourceOf(start);
    let trust = start.trust;
    if (!trust && sourceRepo) {
      const mark = panelTrusted(deps.layout, sourceRepo, os);
      if (mark.unread) {
        deps.note('session.trust.unread', { sessionId: start.sessionId, reason: mark.unread });
      }
      trust = { sourceRepo, panelMark: mark.mark };
    }
    const stateDoc = deps.sessionState?.(task, start);
    const spec: SessionSpec = {
      sessionId: start.sessionId,
      dir: start.dir,
      cwd: start.cwd,
      // Нет модели — нет `--model`: CLI берёт свою по умолчанию.
      ...(start.model !== null ? { model: start.model } : {}),
      ...(start.effort ? { effort: start.effort } : {}),
      brief: start.brief,
      ...(start.resume ? { resume: { conversationId: start.resume.conversationId } } : {}),
      ...(endpoint ? { endpoint } : {}),
      deny: withMcpDeny(start.deny, mcp),
      platform,
      tools: start.tools,
      coreHook: hook.command,
      recorder: { command: hookRecorder.command, log: join(start.dir, HOOKS_LOG) },
      mcpServers,
      permitServer: { name: PERMIT_MCP_SERVER, tool: PERMIT_TOOL },
      layer: start.layer,
      ...(trust ? { trust } : {}),
      env: {
        pin,
        session: {
          PATH: sessionPath(wrapperDir, prefix, loginPath),
          [CORE_PROCS_VAR]: deps.layout.procs,
        },
        nodeRequires: [CAPTURE_SHIM],
      },
      core: {
        taskId: task.taskId,
        stepId: start.stepId,
        stepKind: start.stepKind,
        coreUrl: deps.url,
        sessionToken: token,
        ...(stateDoc ? { state: { ...stateDoc } } : {}),
      },
    };
    return {
      ok: true,
      prepared: {
        start,
        spec,
        adapter,
        route,
        lease,
        compat,
        token,
        context,
        loginPath,
        credentialKind,
        routeKind: route.kind,
        hops,
        ...(mcp ? { mcpHash: mcp.hash } : {}),
        hint: `${TREE_MARKER}=${start.sessionId}`,
      },
    };
  }

  // Версия CLI запущенного сеанса — до строки `session.started` (её пишет `started`).
  const versions = new Map<string, string>();
  async function readVersion(p: Prepared): Promise<string> {
    if (!deps.cliVersion) return 'not-probed';
    try {
      return (await deps.cliVersion(p)) ?? 'unread';
    } catch {
      return 'unread';
    }
  }
  function takeVersion(sessionId: string): string {
    const got = versions.get(sessionId) ?? 'not-probed';
    versions.delete(sessionId);
    return got;
  }

  async function launch(p: Prepared, options: LaunchOptions = {}): Promise<LaunchResult> {
    let got: { handle: SessionHandle; layer: LayerRun } | undefined;
    // Версия читается рядом с запуском, не перед ним: старт сеанса её не ждёт лишний раз.
    const version = readVersion(p);
    const started = await runAction(
      p.start.task,
      { kind: 'process-start', target: p.spec.dir, idempotencyHint: p.hint },
      async () => {
        const launched = await p.adapter.launch(p.spec);
        if (!launched.ok) throw new ActionFailed('launch-refused', launched.reason);
        got = { handle: launched.handle, layer: launched.layer };
        options.afterEffect?.();
        return { hostPid: launched.handle.host.pid, hostStart: launched.handle.host.start };
      },
      { stepId: p.start.stepId },
    );
    if (!started.ok || !got) {
      // Сеанса не будет — метка у звена ему больше не нужна.
      await unlink(p.start.sessionId);
      return {
        ok: false,
        reason: `process-start failed: ${started.ok ? 'no handle' : started.code}`,
      };
    }
    versions.set(p.start.sessionId, await version);
    return { ok: true, ...got };
  }

  function started(p: Prepared, handle: SessionHandle, layer: LayerRun): void {
    const { task, stepId, sessionId } = p.start;
    task.append({
      kind: 'session.started',
      actor: 'core',
      stepId,
      sessionId,
      data: {
        sessionId,
        stepId,
        adapter: p.adapter.id,
        cliVersion: takeVersion(sessionId),
        route: { kind: p.routeKind, id: p.route.id },
        hops: p.hops,
        credentialKind: p.credentialKind,
        modelAsked: p.start.model,
        modelServed: null,
        effort: p.start.effort ?? null,
        hostPid: handle.host.pid,
        hostStart: handle.host.start,
        cliPid: handle.child.pid,
        cliStart: handle.child.start,
        cwd: handle.spawned.cwd,
        argv: handle.spawned.argv,
        resumeOf: p.start.resume?.of ?? null,
        cacheAgeMs: p.start.resume?.cacheAgeMs ?? null,
        layer,
        lease: { leaseId: p.lease.leaseId, rids: p.lease.resources.map((r) => r.rid) },
      },
    });
    task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
    });
    const inventory = journalLayerStart({
      task,
      stepId,
      sessionId,
      dir: p.spec.dir,
      cli: p.adapter.id,
      caps: p.adapter.caps,
      ...(p.adapter.inventory ? { inventoryOf: p.adapter.inventory } : {}),
      pin: p.spec.env.pin,
      cwd: p.spec.cwd,
      skills: p.spec.layer.skills,
      layer,
    });
    layers.started(sessionId, inventory);
  }

  function attach(input: RoadAttach): RoadSession {
    const { task, sessionId, adapter, handle } = input;
    const bound = bindingOf(task, sessionId);
    if (!('binding' in bound)) throw new Error(`session ${sessionId}: ${bound.reason}`);
    const attached = deps.sessions.attach({
      task,
      binding: bound.binding,
      adapter,
      handle,
      context: input.context,
      ...(input.resumed === undefined ? {} : { resumed: input.resumed }),
      ...(input.replayed === undefined ? {} : { replayed: input.replayed }),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });
    let ending: Promise<SessionEnd> | undefined;
    const end = async (mode: Parameters<RoadSession['end']>[0]): Promise<SessionEnd> => {
      const mine = held.get(sessionId);
      const ctx: ScanContext = {
        task,
        handle,
        tmpDir: join(handle.dir, SESSION_TMP),
        readers,
        note: deps.note,
        baseline: mine ? { value: mine.baseline } : readBaseline(task, stateDir, sessionId),
        liveCopies: liveCopies(),
      };
      // Порты — пока их владелец жив: после остановки слушателя уже не назвать.
      const before = await scanBeforeStop(ctx, { name: TREE_MARKER, value: sessionId });
      const stop = await adapter.stop(handle, mode);
      await attached.done;
      const state = task.state.sessions[sessionId]?.state ?? '';
      if (OPEN.has(state)) {
        task.append({
          kind: 'session.transition',
          actor: 'core',
          sessionId,
          data: { sessionId, event: 'exited', from: state as never, to: 'ended' },
        });
      }
      // Сводка записи хуков `observe` — после остановки CLI: новых вызовов записи уже не будет.
      journalLayerObserved(task, sessionId, handle.dir);
      const after = await scanAfterStop(ctx, before, stop);
      const protectedRoots = await protectedAtEnd({
        task,
        sessionId,
        stateDir,
        cwd: input.cwd,
        ownCopies: ownCopiesOf(task),
        liveCopies: liveCopies(),
        ...(mine ? { held: mine.protected } : {}),
      });
      held.delete(sessionId);
      layers.forget(sessionId);
      // Метка у звена — после остановки CLI: до неё сеанс ещё шлёт запросы через звено.
      await unlink(sessionId);
      return { stop, found: after.found, unread: after.unread, protectedRoots };
    };
    return {
      done: attached.done,
      detach: attached.detach,
      end: (mode) => (ending ??= end(mode)),
    };
  }

  return {
    prepare,
    launch,
    started,
    attach,
    contextFor,
    layerInventory: layers.inventoryOf,
    searchPath: async (prefix = []) => sessionPath('', prefix, await deps.loginPath()),
    releaseTask: (task) =>
      releaseTaskEnd(task, {
        liveCopies: liveCopies(),
        routes: deps.routes,
        leases: leases.of(task.taskId),
        ...(deps.stands ? { stands: deps.stands } : {}),
      }),
  };
}
