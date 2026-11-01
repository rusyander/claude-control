import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActionKind, JournalLine } from '@agentdeck/contracts/core/journal';
import type { RouteLease, RouteResource } from '@agentdeck/contracts/core/routes';
import type { Scenario, StepDef, StepKind } from '@agentdeck/contracts/core/scenario';
import type { SessionHandle } from '../../../adapters/index.ts';
import type { DenySet } from '../../../adapters/adapter.types.ts';
import { stopSession } from '../../../adapters/launcher/session-io.ts';
import type { BootedCore } from '../../../bootstrap/boot.ts';
import { roadSessionPort } from '../../../bootstrap/conductor-wiring/loop.ts';
import { observerHooks } from '../../../bootstrap/conductor-wiring/observer.ts';
import type { RoadStart } from '../../../bootstrap/session-road.ts';
import { raiseHumanPoint } from '../../../conductor/human/raise.ts';
import { ActionFailed, runAction } from '../../../conductor/outbox.ts';
import { runTask } from '../../../conductor/run/run.ts';
import type { ConductorHooks } from '../../../conductor/run/run.types.ts';
import { presetStep } from '../../../conductor/scenario/presets.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { readJournalLines } from '../../../journal/read-lines.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { SdkAdapter } from '../../../adapters/sdk-stream/sdk-adapter.ts';
import { briefFor } from '../script.ts';
import type { ChildConfig, ChildResult, KillPoint, ReattachedSession } from './e2e.types.ts';
import { journalKillHit } from './kill-match.ts';

/**
 * Дирижёр фазы 2 для сквозного прогона — внутри процесса ядра. Каждый шаг решается по журналу
 * (F05): перезапущенное ядро продолжает с того места, где журнал остановился, а не сначала.
 *
 * Живая сессия прежнего ядра прикрепляется заново (01 §Sessions at core death, P89): переходник
 * восстанавливает её поток из stdout.log, мост MCP находит новое ядро по `procs.json`; та же
 * сессия доводит шаг. Новая сессия — только вместо кончившейся или потерянной.
 * Ровно один коммит держится тем, что коммит — эффект самой сессии в своей копии.
 */

/** Метка дерева сессии: по ней сверка `process-start` ищет процесс (01 §Outbox). */
export const SESSION_MARKER = 'AGENTDECK_TREE';
export const STUB_MODEL = 'stub-model';
const OPEN_SESSION = new Set(['starting', 'live', 'quiet']);

type Note = (event: string, data?: Record<string, unknown>) => void;

/** Смерть ядра без единой строчки после: запись причины в файл (stdout на Windows асинхронен). */
export function die(killLog: string, why: string): never {
  appendFileSync(killLog, `${JSON.stringify({ at: Date.now(), why, pid: process.pid })}\n`);
  process.kill(process.pid, 'SIGKILL');
  // Сигнал доставляется не мгновенно: ни одна строка JS после него не должна исполниться.
  for (;;) {
    /* ждём смерти */
  }
}

export function installJournalKill(task: LiveTask, kill: KillPoint, killLog: string): void {
  if (kill.at !== 'journal') return;
  const hit = journalKillHit(kill);
  task.subscribe((line, state) => {
    if (hit(line, state)) die(killLog, `journal ${line.kind}#${kill.nth} seq ${line.seq}`);
  });
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new ActionFailed('git', `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

/** Что журнал помнит о запуске сессии (`session.started`). */
function startedFacts(task: LiveTask, sessionId: string): { cwd: string; argv: string[] } {
  const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
  const line = lines.find((l) => l.kind === 'session.started' && l.sessionId === sessionId);
  const data = line?.data as { cwd?: string; argv?: string[] } | undefined;
  return { cwd: data?.cwd ?? '', argv: data?.argv ?? [] };
}

/** Аренда заглушки из журнала: строка `resource.created` вида `stub-server`, ещё живая. */
function journalLease(task: LiveTask, routeId: string): RouteLease | undefined {
  const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
  for (const line of lines) {
    if (line.kind !== 'resource.created') continue;
    const data = line.data as { rid: string; kind: string; ref: string; release: unknown };
    if (data.kind !== 'stub-server' || task.state.resources[data.rid]?.status !== 'live') continue;
    const resource = {
      rid: data.rid,
      kind: data.kind,
      ref: data.ref,
      release: data.release,
    } as RouteResource;
    return { leaseId: data.rid, routeId, model: STUB_MODEL, resources: [resource] };
  }
  return undefined;
}

function cliPin(cliHome: string, marker: string): Record<string, string> {
  for (const dir of [
    cliHome,
    join(cliHome, 'AppData', 'Roaming'),
    join(cliHome, 'AppData', 'Local'),
  ])
    mkdirSync(dir, { recursive: true });
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'LANG'];
  const pin: Record<string, string> = {};
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) pin[name] = value;
  }
  return {
    ...pin,
    HOME: cliHome,
    USERPROFILE: cliHome,
    APPDATA: join(cliHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(cliHome, 'AppData', 'Local'),
    HOMEDRIVE: '',
    HOMEPATH: '',
    [SESSION_MARKER]: marker,
  };
}

/** Запреты шага сквозного прогона; запреты платформы дорога сессии добавляет сама. */
const STEP_DENY: DenySet = { paths: [], commands: [['git', 'push']], mcpTools: [], tools: [] };

export async function conduct(
  core: BootedCore,
  cfg: ChildConfig,
  note: Note,
  killLog: string,
): Promise<ChildResult> {
  const events: string[] = [];
  const launched: string[] = [];
  const stoppedOrphans: string[] = [];
  const reattached: ReattachedSession[] = [];
  const adapter = core.adapters.get(cfg.adapter);
  if (!adapter) throw new Error(`adapter ${cfg.adapter} not registered`);
  const route = core.routes.require(cfg.routeId);

  // ── задача ──
  let task: LiveTask | undefined;
  if (cfg.taskId) {
    task = core.registry.live(cfg.taskId);
    if (!task) throw new Error(`task ${cfg.taskId} not opened by this core`);
  } else {
    task = await core.registry.create({
      title: cfg.taskTitle,
      repos: [{ repoKey: 'r1', path: cfg.repo, baseRef: cfg.baseBranch }],
      build: 'stub-e2e',
      scenario: { id: 'default', version: 1 },
      profilePins: [],
      modelCeiling: null,
      userLayerHash: null,
      envPin: '',
      requirementsSource: 'text',
      // Разрешённая тройка задачи: совместимость дороги сессии решает по ней (06 §Precedence).
      allowedRoutes: [
        { adapter: adapter.id, route: { kind: route.kind, id: route.id }, modelPattern: '*' },
      ],
      routesSourceLevel: 2,
      origin: null,
      launchPolicy: 'confirm',
      ciWait: false,
    });
  }
  const live = task;
  note('task', { taskId: live.taskId });
  if (cfg.kill && cfg.taskId === undefined) {
    // `task.created` пишется внутри `registry.create`, до возврата задачи: смерть «сразу после
    // неё» — здесь, пока ни одной строки после не записано.
    if (cfg.kill.at === 'journal' && cfg.kill.kind === 'task.created') {
      die(killLog, 'journal task.created#1');
    }
    installJournalKill(live, cfg.kill, killLog);
  }

  // ── требования ── (стоит за разбором, которого в фазе 2 нет): id ядра в журнале — без них
  // `step_done` откажет заявке на id, которого ядро не выдавало (G3). Допись идемпотентна по id.
  const extracted = new Set(
    readJournalLines(live.dir, live.taskId)
      .lines.filter((l) => l.kind === 'requirement.extracted')
      .map((l) => (l.data as { requirementId: string }).requirementId),
  );
  for (const [i, r] of (cfg.requirements ?? []).entries()) {
    if (extracted.has(r.id)) continue;
    live.append({
      kind: 'requirement.extracted',
      actor: 'core',
      data: { requirementId: r.id, ordinal: i + 1, text: r.text, source: 'request', stepId: null },
    });
  }

  // ── единица ──
  let unitId = Object.keys(live.state.units)[0];
  if (!unitId) {
    unitId = newId();
    live.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: {
        unitId,
        name: 'unit',
        repoKey: 'r1',
        branch: `agentdeck/${unitId.slice(-8)}`,
        ownedPaths: [],
        after: [],
        contract: false,
        splitId: null,
      },
    });
  }
  const branch = live.state.units[unitId]!.branch;
  const copy = join(cfg.copiesDir, unitId);

  const parked = (actionId: string, kind: ActionKind): ChildResult => ({
    taskId: live.taskId,
    unitId: unitId!,
    copy,
    stepState: 'n/a',
    outcome: 'parked',
    parkedOn: { actionId, kind },
    launched,
    stoppedOrphans,
    reattached,
    events,
  });
  /** Начатое и не законченное после сверки (`retry`/`ask`) — ждём, повтора вслепую нет. */
  const open = (kind: ActionKind, target?: string) =>
    Object.entries(live.state.actions).find(
      ([, a]) =>
        a.kind === kind &&
        (target === undefined || a.target === target) &&
        (a.status === 'started' || a.status === 'awaiting-human'),
    );
  const doneAction = (kind: ActionKind, target?: string) =>
    Object.values(live.state.actions).some(
      (a) =>
        a.kind === kind && a.status === 'done' && (target === undefined || a.target === target),
    );
  const effectKill = (kind: ActionKind): void => {
    if (cfg.kill?.at === 'effect' && cfg.kill.action === kind) die(killLog, `effect ${kind}`);
  };

  // ── копия (действие outbox) ──
  const waitingCopy = open('copy-create', copy);
  if (waitingCopy) return parked(waitingCopy[0], 'copy-create');
  if (!doneAction('copy-create', copy)) {
    const made = await runAction(
      live,
      { kind: 'copy-create', target: copy, idempotencyHint: 'dir' },
      async () => {
        mkdirSync(dirname(copy), { recursive: true });
        git(dirname(copy), ['clone', '--quiet', '--branch', cfg.baseBranch, cfg.repo, copy]);
        git(copy, ['checkout', '--quiet', '-b', branch]);
        git(copy, ['config', 'user.name', 'agentdeck-stub']);
        git(copy, ['config', 'user.email', 'stub@example.invalid']);
        git(copy, ['config', 'core.autocrlf', 'false']);
        effectKill('copy-create');
        return { dir: copy, branch };
      },
      { unitId },
    );
    if (!made.ok) throw new Error(`copy-create failed: ${made.code}`);
  }

  // ── шаг: исполнитель дирижёра этапа 4 (`runTask`) над дорогой сессии ядра ──
  // Шаг заводит и запускает исполнитель по одношаговому сценарию; прогон только готовит копию,
  // разбирает сессии прежнего ядра и ждёт исхода. Шаг — первый (и единственный) в журнале.
  const stepState = (): string => {
    const id = Object.keys(live.state.steps)[0];
    return id ? (live.state.steps[id]?.state ?? 'absent') : 'absent';
  };
  const result = (outcome: ChildResult['outcome']): ChildResult => ({
    taskId: live.taskId,
    unitId: unitId!,
    copy,
    stepState: stepState(),
    outcome,
    launched,
    stoppedOrphans,
    reattached,
    events,
  });

  // Запуск прежнего ядра без строки сессии (эффект `process-start` до `session.started`): в
  // журнале сессии нет — дерево снимается, шаг получает новую сессию (правило продолжения).
  const sessionDir = (sessionId: string): string => join(cfg.sessionsDir, sessionId);
  const waitingStart = open('process-start');
  if (waitingStart) return parked(waitingStart[0], 'process-start');
  for (const action of Object.values(live.state.actions)) {
    if (action.kind !== 'process-start' || action.status !== 'done') continue;
    const sessionId = action.target.split(/[\\/]/).pop()!;
    if (live.state.sessions[sessionId]) continue;
    const stopped = await stopSession(action.target, 'tree');
    stoppedOrphans.push(`${sessionId}:${stopped.how}`);
  }
  // Открытые сессии прежнего ядра (01 §Sessions at core death, P89): живой хост — та же сессия
  // продолжает шаг; кончилась — `exited`; хост мёртв — дерево снимается, `lost`; живость не
  // прочитана — сессию не хороним и не заменяем.
  let resumed: { stepId: string; handle: SessionHandle; replayed?: number } | undefined;
  for (const [sessionId, session] of Object.entries(live.state.sessions)) {
    if (!OPEN_SESSION.has(session.state)) continue;
    const got =
      'reattach' in adapter && !resumed
        ? await (adapter as SdkAdapter).reattach({
            sessionId,
            dir: sessionDir(sessionId),
            host: { pid: session.hostPid, start: session.hostStart },
            spawned: startedFacts(live, sessionId),
            permitServer: true,
          })
        : ({ state: 'unknown', reason: 'adapter cannot reattach' } as const);
    note('reattach', {
      sessionId,
      state: got.state,
      ...('reason' in got ? { reason: got.reason } : {}),
    });
    if (got.state === 'live') {
      resumed = {
        stepId: session.stepId,
        handle: got.handle,
        ...(got.replayed === undefined ? {} : { replayed: got.replayed }),
      };
      reattached.push({
        sessionId,
        hostPid: got.handle.host.pid,
        hostStart: got.handle.host.start,
        conversationId: got.conversationId,
        replayed: got.replayed,
      });
      // Ядро умерло между `session.started` и переходом: сессия жива — переход пишется сейчас.
      if (session.state === 'starting') {
        live.append({
          kind: 'session.transition',
          actor: 'core',
          sessionId,
          data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
        });
      }
      continue;
    }
    if (got.state === 'unknown') return result('session-unknown');
    if (got.state === 'lost') {
      const stopped = await stopSession(sessionDir(sessionId), 'tree');
      stoppedOrphans.push(`${sessionId}:${stopped.how}`);
    }
    live.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data:
        got.state === 'lost'
          ? { sessionId, event: 'host-dead', from: session.state, to: 'lost' }
          : { sessionId, event: 'exited', from: session.state, to: 'ended' },
    });
  }
  // Заявление принято прежним ядром (`step.claimed` переводит шаг в `checking`), а сессии,
  // которая его сделала, уже нет — запускать нечего.
  if (cfg.until === 'claimed' && stepState() === 'checking' && !resumed) return result('claimed');

  // Дорога сессии ядра (03 §Launcher): та же, что у продукта, — совместимость по разрешённой
  // тройке задачи, аренда маршрута (живая из журнала после перезапуска), токен, PATH входа,
  // настоящий хук ядра, оверлей запретов, прикрепление и поиск ресурсов на остановке.
  const startOf = (stepId: string, sessionId: string): RoadStart => {
    const lease = journalLease(live, route.id);
    return {
      task: live,
      stepId,
      stepKind: cfg.stepKind,
      adapterId: adapter.id,
      routeId: route.id,
      model: STUB_MODEL,
      sessionId,
      dir: sessionDir(sessionId),
      cwd: copy,
      brief: briefFor({ stepId, copyRoot: copy, request: cfg.request }),
      deny: STEP_DENY,
      tools: 'all',
      // Слой человека снимается там, где переходник это умеет; иначе (Qwen) его нет и так: дом CLI
      // — одноразовый каталог стенда, а не настоящий.
      layer: { hooks: cfg.layerMode ?? (adapter.caps.layerControl ? 'off' : 'on'), skills: 'on' },
      // Набор слоя — выбор теста, а не чужой репозиторий: исходник отмечен доверенным панелью,
      // иначе `on` у Claude шёл бы `observe` (недоверенная копия, F-86).
      ...(cfg.layerMode ? { trust: { sourceRepo: cfg.repo, panelMark: true } } : {}),
      pin: cliPin(cfg.cliHome, sessionId),
      pathPrefix: [dirname(process.execPath)],
      ...(lease ? { lease } : {}),
    };
  };
  let cliInitiated = false;
  let claimedTurnEnded = false;
  let ended = false;
  const port = roadSessionPort({
    task: live,
    road: {
      prepare: (start) => core.road.prepare(start),
      launch: (prepared, options) => core.road.launch(prepared, options),
      started: (prepared, handle, layer) => {
        launched.push(handle.sessionId);
        core.road.started(prepared, handle, layer);
      },
      attach: (input) => core.road.attach(input),
      contextFor: (start) => core.road.contextFor(start),
    },
    adapterOf: (id) => (id === adapter.id ? adapter : undefined),
    startOf: (s, sessionId) => startOf(s.stepId, sessionId),
    resumeOf: (stepId) =>
      resumed?.stepId === stepId
        ? {
            handle: resumed.handle,
            ...(resumed.replayed === undefined ? {} : { replayed: resumed.replayed }),
          }
        : undefined,
    launch: { afterEffect: () => effectKill('process-start') },
    onEvent: (_stepId, event) => {
      events.push(event.type);
      if (event.type === 'turn.cli-initiated') cliInitiated = true;
      if (event.type === 'turn.ended' && stepState() !== 'running') claimedTurnEnded = true;
    },
    onEnded: () => {
      ended = true;
    },
    note,
  });
  // Сессия прежнего ядра, чей шаг уже заявлен: исполнитель её не откроет (шаг в `checking`),
  // а её конец хода — тот исход, которого ждёт прогон; прикрепляем здесь.
  if (resumed && stepState() !== 'running' && stepState() !== 'queued') {
    const rec = live.state.steps[resumed.stepId];
    await port.open(
      {
        taskId: live.taskId,
        unitId,
        repoKey: 'r1',
        copyDir: copy,
        stepId: resumed.stepId,
        def: stubStep(cfg.stepKind),
        round: rec?.round ?? 0,
        sessionId: null,
      },
      [],
      { turnEnded: () => undefined, tool: () => undefined, ended: () => undefined },
    );
  }

  // Проверок у сквозного прогона нет: заявленный шаг стоит в `checking`, пока прогон не кончится.
  // Остановка рвёт крючок без вердикта — шаг в журнале не двигается (его судит следующее ядро).
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const hooks: ConductorHooks = {
    preStep: () =>
      Promise.resolve({
        verdict: { ok: true },
        sections: [{ id: 'task', text: cfg.request, from: 'stub-e2e' }],
      }),
    postStep: async () => {
      await released;
      throw new Error('conduct stopped');
    },
  };
  const scenario: Scenario = {
    id: 'default',
    version: 1,
    title: 'stub e2e',
    steps: [stubStep(cfg.stepKind)],
  };
  // Исполнитель ведёт только идущую задачу; запуск стенда — без подтверждения человека (как
  // раньше прогон шёл и по черновику), один раз на журнал: перезапуск видит `running`.
  const from = live.state.task;
  if (from === 'draft' || from === 'awaiting-launch') {
    live.append({
      kind: 'task.transition',
      actor: 'core',
      data: { taskId: live.taskId, event: 'launch', from, to: 'running' },
    });
  }
  const run = runTask(live, {
    // Зона наблюдателя дирижёра продукта (подсказки одним сообщением платформы на конце хода);
    // из зависимостей она читает только реестр задач.
    hooks: [observerHooks({ registry: core.registry }), hooks],
    scenarioOf: (ref) =>
      ref.id === scenario.id && ref.version === scenario.version ? scenario : undefined,
    sessions: port,
    raise: (r) => raiseHumanPoint(live, r),
    now: Date.now,
    note,
  });

  const deadline = Date.now() + cfg.waitMs;
  let outcome: ChildResult['outcome'] = 'timeout';
  for (;;) {
    if (cfg.until === 'claimed' && stepState() === 'checking' && claimedTurnEnded) {
      outcome = 'claimed';
      break;
    }
    if (cfg.until === 'cli-initiated' && cliInitiated) {
      outcome = 'cli-initiated';
      break;
    }
    if (ended) {
      outcome = cfg.until === 'claimed' && stepState() === 'checking' ? 'claimed' : 'session-ended';
      break;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Разговор CLI, каким его увидело ЭТО ядро (история + живой хвост) — доказательство той же сессии.
  for (const entry of reattached) {
    entry.conversationId =
      (resumed && (adapter as SdkAdapter).session(resumed.handle)?.conversationId) ?? null;
  }
  // `stop` ставит остановку синхронно — освобождённый крючок уже не даст исполнителю хода.
  const stopping = run.stop('end');
  release();
  await stopping;
  // Сессия, кончившаяся сама, исполнителем не снимается — дорога всё равно ищет её остаток.
  await port.release();
  return result(outcome);
}

/** Одношаговый сценарий прогона: шаг `work` того вида, что задан стендом. */
function stubStep(kind: string): StepDef {
  return presetStep('work', kind as StepKind, 'Работа', []);
}
