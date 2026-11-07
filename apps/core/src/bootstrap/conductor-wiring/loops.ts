import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario, ScenarioRef } from '@agentdeck/contracts/core/scenario';
import type { AdapterRegistry } from '../../adapters/index.ts';
import { stopSession } from '../../adapters/launcher/session-io.ts';
import type { SdkAdapter } from '../../adapters/sdk-stream/sdk-adapter.ts';
import { unitCopyOf } from '../../conductor/copy/index.ts';
import { raiseHumanPoint } from '../../conductor/human/raise.ts';
import { runTask } from '../../conductor/run/run.ts';
import type {
  ConductorHooks,
  RunEconomy,
  XlPort,
  RunHandle,
  SessionEvents,
  StepCtx,
} from '../../conductor/run/run.types.ts';
import { decideRouting, presetOf, readLibraryScenario } from '../../conductor/scenario/index.ts';
import type { SeatPort } from '../../conductor/schedule/index.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { SessionRoad } from '../session-road.ts';
import { createEndCloser, OPEN_SESSION } from './close-ended.ts';
import type { LoopOptions } from './conductor-wiring.types.ts';
import { roadSessionPort, type ResumedSession, type RoadPortDeps } from './loop.ts';
import { journaledSessionDir, processPin, stepStart } from './session-start.ts';

/**
 * Исполнитель в продукте (зона B): у каждой запущенной задачи этого ядра — один `runTask`. Задача,
 * открытая загрузкой (`openUnfinished`), и задача, запущенная командой после загрузки, подхватываются
 * одним обходом живых задач. На старте исполнителя — разбор сессий прежнего ядра (01 §Sessions at
 * core death, P89): живая продолжает свой шаг, кончившаяся закрывается, у мёртвого хоста снимается
 * дерево, непрочитанная живость задачу не запускает — она помечается и пробуется снова.
 */

export interface LoopsDeps {
  registry: TaskRegistry;
  road: SessionRoad;
  adapters: AdapterRegistry;
  scenariosDir: string;
  hooks: readonly ConductorHooks[];
  note(event: string, data: Record<string, unknown>): void;
  options?: LoopOptions;
  /** Экономика исполнителя ядра (этап 5): окно, продолжение, бриф и пакет ревью, бюджет. */
  economy?: RunEconomy;
  /** Места сеансов (этап 11): каждый `runTask` берёт место шагу до сеанса. */
  allocator?: SeatPort;
  measureBase?: RoadPortDeps['measureBase'];
  /** Значения окружения задачи (этап 10, F6): только память, имена — в `task.created.session`. */
  taskEnv?: { get(taskId: string): Readonly<Record<string, string>> | undefined };
  /** Дети XL (Q-2 s11): родитель ждёт их и запускает следующую волну. */
  xl?: XlPort;
}

export interface Loops {
  /** Один обход сейчас (тест и пробуждение по строке журнала). */
  sweep(): Promise<void>;
  /** Исполнители задачи по id (живые). */
  running(): string[];
  /** Остановить всё: исполнители `keep` — сессии переживают ядро, их подхватит следующее. */
  stop(): Promise<void>;
}

/**
 * Задача идёт и не кончилась: её ведёт исполнитель (что делать в паузе — решает `next`). Оценка —
 * тоже: шаги до точки деления (план) идут сессиями до запуска, деление (D) переводит задачу дальше.
 */
const LAUNCHED = new Set(['estimating', 'running', 'paused', 'waiting-window', 'publishing']);
const HOLD_RETRY_MS = 30_000;
const SWEEP_MS = 1_000;

const keyOf = (ref: ScenarioRef): string => `${ref.id}@${ref.version}`;

interface Loop {
  task: LiveTask;
  run: RunHandle | null;
  release: (() => Promise<void>) | null;
  /** Не запущен: живость сессии прежнего ядра не прочитана; когда пробовать снова. */
  heldUntil?: number;
  heldReason?: string;
}

/** Что журнал помнит о запуске сессии (`session.started`): для прикрепления к её хосту. */
function startedFacts(task: LiveTask, sessionId: string): { cwd: string; argv: string[] } {
  const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
  const line = lines.find((l) => l.kind === 'session.started' && l.sessionId === sessionId);
  const data = line?.data as { cwd?: string; argv?: string[] } | undefined;
  return { cwd: data?.cwd ?? '', argv: data?.argv ?? [] };
}

type ReattachResult = { resumed: Map<string, ResumedSession> } | { unknown: string };

/** Сессии прежнего ядра этой задачи — до первого хода исполнителя. */
async function reattachTask(
  task: LiveTask,
  adapters: AdapterRegistry,
  note: LoopsDeps['note'],
): Promise<ReattachResult> {
  const resumed = new Map<string, ResumedSession>();
  // Запуск без строки сессии (эффект `process-start` до `session.started`): сессии в журнале нет,
  // дерево снимается — шаг получит новую.
  for (const action of Object.values(task.state.actions)) {
    if (action.kind !== 'process-start' || action.status !== 'done') continue;
    const sessionId = action.target.split(/[\\/]/).pop()!;
    if (task.state.sessions[sessionId]) continue;
    const stopped = await stopSession(action.target, 'tree');
    note('loop.orphan-stopped', { taskId: task.taskId, sessionId, how: stopped.how });
  }
  for (const [sessionId, session] of Object.entries(task.state.sessions)) {
    if (!OPEN_SESSION.has(session.state)) continue;
    const adapter = adapters.get(session.adapter);
    const dir = journaledSessionDir(task, sessionId);
    // Один шаг — одна живая сессия: вторая открытая на том же шаге не продолжает его.
    const got =
      adapter && 'reattach' in adapter && !resumed.has(session.stepId)
        ? await (adapter as SdkAdapter).reattach({
            sessionId,
            dir,
            host: { pid: session.hostPid, start: session.hostStart },
            spawned: startedFacts(task, sessionId),
            permitServer: true,
          })
        : ({ state: 'lost', reason: 'no reattach for this session' } as const);
    note('loop.reattach', {
      taskId: task.taskId,
      sessionId,
      state: got.state,
      ...('reason' in got ? { reason: got.reason } : {}),
    });
    if (got.state === 'live') {
      resumed.set(session.stepId, {
        handle: got.handle,
        ...(got.replayed === undefined ? {} : { replayed: got.replayed }),
      });
      // Ядро умерло между `session.started` и переходом: сессия жива — переход пишется сейчас.
      if (session.state === 'starting') {
        task.append({
          kind: 'session.transition',
          actor: 'core',
          sessionId,
          data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
        });
      }
      continue;
    }
    // Живость не прочитана: сессию не хороним и не заменяем — задача ждёт.
    if (got.state === 'unknown') return { unknown: `session ${sessionId}: ${got.reason}` };
    if (got.state === 'lost') await stopSession(dir, 'tree');
    task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data:
        got.state === 'lost'
          ? { sessionId, event: 'host-dead', from: session.state, to: 'lost' }
          : { sessionId, event: 'exited', from: session.state, to: 'ended' },
    });
  }
  return { resumed };
}

const NO_EVENTS: SessionEvents = {
  turnEnded: () => undefined,
  tool: () => undefined,
  ended: () => undefined,
};

export function startLoops(deps: LoopsDeps): Loops {
  const options = deps.options ?? {};
  const pin = options.pin ?? (() => processPin());
  const loops = new Map<string, Loop>();
  const starting = new Map<string, Promise<void>>();
  const watched = new Map<string, () => void>();
  const scenarios = new Map<string, Scenario>();
  const closer = createEndCloser({ hooks: deps.hooks, note: deps.note });
  const released = new Set<string>();
  let stopped = false;
  let sweeping: Promise<void> | null = null;

  /**
   * Конец задачи дорогой сессии — после того как её сессии сняты: находки сессий, ресурсы ядра
   * `task-end` (контейнеры сервисов, стенд) и аренды маршрутов (сервер модели-заглушки, локальная
   * модель). Без этого вызова аренда и сервер маршрута переживали задачу (замер: задача «ask»,
   * сервер заглушки жив после `done`). Раз на задачу за жизнь ядра; утечка названа в журнале
   * ядра, следующая загрузка пробует её снова (подтверждённые строки не трогаются).
   */
  const releaseEnded = async (task: LiveTask): Promise<void> => {
    if (released.has(task.taskId)) return;
    released.add(task.taskId);
    try {
      const got = await deps.road.releaseTask(task);
      if (got.leaks.length > 0 || got.unread.length > 0)
        deps.note('loop.task-release-leaks', {
          taskId: task.taskId,
          leaks: got.leaks,
          unread: got.unread,
        });
    } catch (error) {
      deps.note('loop.task-release-failed', { taskId: task.taskId, reason: String(error) });
    }
  };

  const scenarioOf = (ref: ScenarioRef): Scenario | undefined =>
    presetOf(ref) ?? scenarios.get(keyOf(ref));

  /** Сценарии задачи из библиотеки — заранее: исполнитель берёт их синхронно. */
  const preload = async (task: LiveTask): Promise<void> => {
    const st = task.state;
    for (const ref of [st.created?.scenario, st.scenario?.ref, st.scenario?.pending?.to]) {
      if (!ref || scenarioOf(ref)) continue;
      const got = await readLibraryScenario(deps.scenariosDir, ref);
      if (got.kind === 'value') scenarios.set(keyOf(ref), got.scenario);
      else
        deps.note('loop.scenario-unread', {
          taskId: task.taskId,
          ref: keyOf(ref),
          kind: got.kind,
          ...('reason' in got ? { reason: got.reason } : {}),
        });
    }
  };

  /** Контекст шага, ждущего проверки: его сессию прикрепляют до хода исполнителя. */
  const checkingCtx = (task: LiveTask, stepId: string): StepCtx | null => {
    const st = task.state;
    const rec = st.steps[stepId];
    const ref = st.scenario?.ref ?? st.created?.scenario;
    const def = ref ? scenarioOf(ref)?.steps.find((d) => d.id === rec?.stepDefId) : undefined;
    if (!rec || !def) return null;
    return {
      taskId: task.taskId,
      unitId: rec.unitId,
      repoKey: st.units[rec.unitId]?.repoKey ?? '',
      copyDir: unitCopyOf(task, rec.unitId)?.dir ?? null,
      stepId,
      def,
      round: rec.round,
      sessionId: null,
      // Тот же вход суда, что у исполнителя (лестницы, окна, контур): иначе прикреплённый шаг
      // судился бы без лестницы и без контура.
      routing: decideRouting(
        st,
        { stepId, unitId: rec.unitId, def },
        deps.economy?.routingEnv?.(task),
      ),
    };
  };

  const begin = async (task: LiveTask): Promise<Loop> => {
    await preload(task);
    const got = await reattachTask(task, deps.adapters, deps.note);
    if ('unknown' in got) {
      deps.registry.flag(task.taskId, `session liveness unread: ${got.unknown}`);
      return {
        task,
        run: null,
        release: null,
        heldUntil: Date.now() + HOLD_RETRY_MS,
        heldReason: got.unknown,
      };
    }
    const resumed = got.resumed;
    const port = roadSessionPort({
      task,
      road: deps.road,
      adapterOf: (id) => deps.adapters.get(id),
      startOf: (s, sessionId) => {
        const env = deps.taskEnv?.get(task.taskId);
        const made = stepStart(
          { task, pin: pin(), ...pathPrefix(), ...(env ? { env } : {}) },
          s,
          sessionId,
        );
        if (made.ok) return made.start;
        deps.note('loop.start-refused', {
          taskId: task.taskId,
          stepId: s.stepId,
          reason: made.reason,
        });
        return null;
      },
      resumeOf: (stepId) => resumed.get(stepId),
      // Кончившаяся сессия прежнего ядра шаг больше не продолжает: следующий запуск — новая.
      onEnded: (stepId, sessionId) => {
        if (resumed.get(stepId)?.handle.sessionId === sessionId) resumed.delete(stepId);
      },
      ...(deps.measureBase ? { measureBase: deps.measureBase } : {}),
      note: deps.note,
    });
    // Шаг, заявленный прежним ядром, исполнитель не откроет (он в `checking`): его живую сессию
    // прикрепляем здесь — права решает ядро, конец потока снимает её остаток. Вернётся шаг на
    // доработку — исполнитель получит эту же сессию.
    for (const stepId of resumed.keys()) {
      const state = task.state.steps[stepId]?.state;
      if (state === 'running' || state === 'queued') continue;
      const s = checkingCtx(task, stepId);
      if (!s) {
        deps.note('loop.reattach-unplaced', { taskId: task.taskId, stepId, state });
        continue;
      }
      await port.open(s, [], NO_EVENTS);
    }
    const run = runTask(task, {
      hooks: deps.hooks,
      scenarioOf,
      sessions: port,
      raise: (r) => raiseHumanPoint(task, r),
      copyDirOf: (unitId) => unitCopyOf(task, unitId)?.dir ?? null,
      now: Date.now,
      note: deps.note,
      ...(deps.economy ? { economy: deps.economy } : {}),
      ...(deps.allocator ? { allocator: deps.allocator } : {}),
      ...(deps.xl ? { xl: deps.xl } : {}),
      ...(options.upkeepEveryMs === undefined ? {} : { upkeepEveryMs: options.upkeepEveryMs }),
    });
    deps.note('loop.started', { taskId: task.taskId, resumed: resumed.size });
    return { task, run, release: () => port.release() };
  };

  const pathPrefix = (): { pathPrefix?: readonly string[] } =>
    options.pathPrefix ? { pathPrefix: options.pathPrefix } : {};

  const end = async (loop: Loop, sessions: 'end' | 'keep'): Promise<void> => {
    if (!loop.run) return;
    await loop.run.stop(sessions);
    // Кончившаяся задача: остаток её сессий дорога ищет на снятии; живые после `keep` не трогаем.
    if (sessions === 'end') await loop.release?.();
  };

  const sweepOnce = async (): Promise<void> => {
    const now = Date.now();
    for (const task of deps.registry.liveTasks()) {
      if (stopped) return;
      const id = task.taskId;
      const have = loops.get(id);
      // Кончилась без исполнителя (отмена до запуска, отказ оценки, крах до закрытия) — тот же
      // конец, что у исполнителя; исполнитель, ещё стоящий у кончившейся задачи, закроет её сам.
      if (task.state.ended !== null && !have?.run) {
        if (starting.has(id)) continue;
        await closer.close(task);
        // Давно кончившаяся задача со всем снятым обход не будит: снимать нечего.
        if (Object.values(task.state.resources).some((r) => r.status !== 'verified'))
          await releaseEnded(task);
        watched.get(id)?.();
        watched.delete(id);
        continue;
      }
      if (!watched.has(id)) {
        // Запуск командой будит обход сразу, а не через шаг.
        watched.set(
          id,
          task.subscribe((line) => {
            if (line.kind === 'task.transition') void sweep();
          }),
        );
      }
      if (have && (have.run || (have.heldUntil ?? 0) > now)) continue;
      if (starting.has(id)) continue;
      if (!LAUNCHED.has(task.state.task)) continue;
      const p = begin(task)
        .then((loop) => {
          if (stopped) return end(loop, 'keep');
          loops.set(id, loop);
        })
        .catch((error: unknown) => {
          deps.note('loop.failed', { taskId: id, reason: String(error) });
          loops.set(id, { task, run: null, release: null, heldUntil: Date.now() + HOLD_RETRY_MS });
        })
        .finally(() => starting.delete(id));
      starting.set(id, p);
      await p;
    }
    // Задача кончилась или ушла из живых (аренда потеряна): исполнитель снимается.
    for (const [id, loop] of loops) {
      const live = deps.registry.live(id);
      if (live && live.state.ended === null) continue;
      if (live && loop.run) closer.claim(id);
      loops.delete(id);
      watched.get(id)?.();
      watched.delete(id);
      await end(loop, live ? 'end' : 'keep').catch((error: unknown) =>
        deps.note('loop.stop-failed', { taskId: id, reason: String(error) }),
      );
      if (live) await releaseEnded(live);
    }
  };

  let queued: Promise<void> | null = null;
  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // Один обход за раз; просьбы во время обхода сливаются в один следующий.
    if (queued) return queued;
    const after = sweeping ?? Promise.resolve();
    const next = after.then(() => {
      queued = null;
      return sweepOnce();
    });
    queued = next;
    sweeping = next.catch((error: unknown) =>
      deps.note('loop.sweep-failed', { reason: String(error) }),
    );
    return sweeping;
  };

  const timer = setInterval(() => void sweep(), options.sweepMs ?? SWEEP_MS);
  timer.unref?.();
  void sweep();

  return {
    sweep,
    running: () => [...loops].filter(([, l]) => l.run).map(([id]) => id),
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const off of watched.values()) off();
      watched.clear();
      await Promise.allSettled(starting.values());
      await sweeping?.catch(() => undefined);
      for (const loop of loops.values()) await end(loop, 'keep');
      loops.clear();
    },
  };
}
