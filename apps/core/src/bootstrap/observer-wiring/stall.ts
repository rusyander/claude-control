import { stopSession } from '../../adapters/launcher/session-io.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { stopTree as stopProcessTree, type TreeStopReport } from '../../platform/tree-stop.ts';
import { hostVerdict, type HostVerdict } from '../../session-host/client.ts';
import {
  sessionStallThreshold,
  STALL_DEFAULT_MS,
  type StallThreshold,
} from '../../observer/stall/index.ts';
import {
  probeTrees,
  type LivenessProbe,
  type ProcessIdentity,
  type TreeProbe,
} from '../../platform/process-identity.ts';
import { cpuSourceOf } from '../../platform/process-table.ts';
import { journaledSessionDir } from '../conductor-wiring/session-start.ts';
import type { ActivityBook, SessionActivity } from './activity.ts';
import type { ObserverNote } from './observer-wiring.types.ts';

/**
 * Тик тишины сессий (этап 8, F9, 06:138-139, P18, P56): по книге активности (`activity.ts`) и
 * рабочему монотонному времени ядра (сон машины вычтен, сдвиг стенных часов не виден) пишет
 * переходы машины сессии, которые раньше никто не писал:
 * - `silent` live → quiet: ход в работе, событий нет `silentAfterMs`, CLI не ждёт ответа о праве
 *   (`permit.request` последним), у шага нет открытого вопроса и он не `waiting-human` — ожидание
 *   человека тишиной не считается. Тот же снимок даёт базу процессора дерева хоста;
 * - `deadline` quiet → quiet ОДИН раз на эпизод тишины, когда тишина перешла порог класса
 *   ожидаемого инструмента (выученный p95 × 3, пол 2 мин, иначе 10 мин), + строка `session.probe`
 *   (pid + старт хоста, прирост процессора дерева от базы). Живой — только показан (предикат
 *   `stall`), шаг идёт дальше; мёртвый — дерево снимается и пишется `host-dead` → lost (правило
 *   продолжения берёт шаг), даже если снятие бросило; живость не прочитана — ничего не снято;
 * - `deadline` starting → ended: старт дольше `startingDeadlineMs` — дерево снимается;
 * - `host-dead` → lost (этап 11): хост открытого сеанса сверяется не реже `hostCheckMs` судом
 *   `hostVerdict` — та же доказанная смерть (свежий снимок), что у снятия места владельцем, и
 *   исхода хоста нет. Пережившее хост дерево CLI снимается; строка пишется один раз — сеанс
 *   уже не открыт, и повтор (второй тик, сверка загрузки) её не пишет. Без этого сеанс с убитым
 *   хостом числился живым: исход хоста не придёт, и насос сеанса ждал бы его вечно.
 * Отсчёт идёт от прикрепления: после перезапуска ядра старые сессии не «застревают» на загрузке.
 * Все пробы тика — ОДИН снимок таблицы процессов (03:165).
 */

export interface StallOptions {
  /** Тишина с ходом в работе до `silent` (спека: 60 с). */
  silentAfterMs?: number;
  /** Порог без выученного p95 (спека: 10 мин). */
  stallDefaultMs?: number;
  /** Срок старта сессии (спека: 60 с). */
  startingDeadlineMs?: number;
  /** Сверка хостов открытых сеансов не чаще, чем раз в столько (5 с — такт удара мест); 0 — каждый тик. */
  hostCheckMs?: number;
}

export const SILENT_AFTER_MS = 60_000;
export const HOST_CHECK_MS = 5_000;
export const STARTING_DEADLINE_MS = 60_000;

export interface StallWatchDeps {
  activity: ActivityBook;
  /** Рабочее монотонное время ядра (`clock.activeMono`), читается на каждый тик. */
  now: () => number;
  probe: LivenessProbe;
  /** Выученные p95 вызова по классу (экономика); нет — порог из значения спеки. */
  toolP95?: () => Readonly<Record<string, number>> | null;
  /** Снять дерево сессии; по умолчанию — `stopSession` каталога сессии из журнала. */
  stop?: (task: LiveTask, sessionId: string) => Promise<unknown>;
  note: ObserverNote;
  options?: StallOptions;
  /**
   * Вопрос о праве сессии ждёт решения ядра вне потока (сервер права `agentdeck-permit`, вызов
   * принят и не отвечен). Нет — только вопросы в самом потоке (`permit.request`) и открытые
   * вопросы человеку шага.
   */
  permitPending?: (sessionId: string) => boolean;
  /** Суд о хосте сеанса; по умолчанию — `hostVerdict` каталога сессии из журнала пробой `probe`. */
  hostOf?: (task: LiveTask, sessionId: string) => Promise<HostVerdict>;
  /**
   * Снять дерево CLI, пережившее хост; по умолчанию — `stopTree` платформы. Чистая остановка —
   * пустой `residual` без `unknown`; иначе CLI мог выжить, и сеанс не кончается.
   */
  stopOrphan?: (child: ProcessIdentity) => Promise<Pick<TreeStopReport, 'residual' | 'unknown'>>;
}

export interface StallWatch {
  /** Следить за сессиями задачи; отсчёт тишины и старта — с этого момента. */
  attach(task: LiveTask): void;
  detach(taskId: string): void;
  /** Один проход по всем задачам; одновременный второй вызов ждёт первый. */
  tick(): Promise<void>;
  /** Тик по таймеру; ответ — остановка. */
  start(everyMs: number): () => void;
}

const OPEN = new Set(['starting', 'live', 'quiet']);

interface Watched {
  /** Рабочее время, с которого сессия числится в `starting`. */
  startingSince?: number;
  /** Процессор дерева на переходе в `quiet` (база прироста). */
  baselineCpu: number | null;
  /** `lastAt` эпизода тишины, по которому проба уже записана: один эпизод — одна проба. */
  probedAt?: number;
  /** Провал снятия сироты уже записан: повторные сверки пробуют снова, но молча. */
  orphanStopNoted?: boolean;
}

type Move =
  | { kind: 'silent'; task: LiveTask; sessionId: string; lastAt: number; id: ProcessIdentity }
  | {
      kind: 'deadline';
      task: LiveTask;
      sessionId: string;
      lastAt: number;
      id: ProcessIdentity;
      threshold: StallThreshold;
    }
  | { kind: 'start-deadline'; task: LiveTask; sessionId: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Ход ждёт человека: открытый вопрос шага или сам шаг в `waiting-human`. */
function waitsForHuman(task: LiveTask, stepId: string): boolean {
  const st = task.state;
  if (st.steps[stepId]?.state === 'waiting-human') return true;
  return Object.values(st.asks).some((a) => a.state === 'open' && a.stepId === stepId);
}

export function createStallWatch(deps: StallWatchDeps): StallWatch {
  const silentAfterMs = deps.options?.silentAfterMs ?? SILENT_AFTER_MS;
  const stallDefaultMs = deps.options?.stallDefaultMs ?? STALL_DEFAULT_MS;
  const startingDeadlineMs = deps.options?.startingDeadlineMs ?? STARTING_DEADLINE_MS;
  const stop =
    deps.stop ??
    ((task: LiveTask, sessionId: string) =>
      stopSession(journaledSessionDir(task, sessionId), 'tree'));
  const hostCheckMs = deps.options?.hostCheckMs ?? HOST_CHECK_MS;
  const hostOf =
    deps.hostOf ??
    ((task: LiveTask, sessionId: string) =>
      hostVerdict(journaledSessionDir(task, sessionId), { probe: deps.probe }));
  const stopOrphan = deps.stopOrphan ?? ((child: ProcessIdentity) => stopProcessTree(child));
  const tasks = new Map<string, LiveTask>();
  const watched = new Map<string, Watched>();
  let running: Promise<void> | null = null;
  /** Рабочее время прошлой сверки хостов; первая — на первом тике. */
  let hostCheckedAt = Number.NEGATIVE_INFINITY;

  const watch = (sessionId: string): Watched => {
    let w = watched.get(sessionId);
    if (!w) {
      w = { baselineCpu: null };
      watched.set(sessionId, w);
    }
    return w;
  };

  /** Сессии задачи под отсчётом: книга знакомится с ними сейчас, старт отсчитывается отсюда. */
  const enrol = (task: LiveTask, at: number): void => {
    for (const [sessionId, session] of Object.entries(task.state.sessions)) {
      if (!OPEN.has(session.state)) continue;
      deps.activity.touch(sessionId);
      const w = watch(sessionId);
      if (session.state === 'starting') w.startingSince ??= at;
    }
  };

  const append = (task: LiveTask, line: Parameters<LiveTask['append']>[0]): boolean => {
    try {
      task.append(line);
      return true;
    } catch (error) {
      deps.note('observer.stall.append-failed', {
        taskId: task.taskId,
        kind: line.kind,
        reason: reasonOf(error),
      });
      return false;
    }
  };

  const transition = (
    task: LiveTask,
    sessionId: string,
    data: { event: 'silent' | 'deadline' | 'host-dead'; from: string; to: string },
  ): boolean =>
    append(task, {
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      stepId: task.state.sessions[sessionId]?.stepId,
      data: { sessionId, ...data },
    } as Parameters<LiveTask['append']>[0]);

  /** Что сделать с сессией сейчас (без записи): решения тика собираются до общего снимка. */
  const plan = (
    task: LiveTask,
    sessionId: string,
    entry: SessionActivity,
    at: number,
  ): Move | null => {
    const session = task.state.sessions[sessionId]!;
    const w = watch(sessionId);
    const id = { pid: session.hostPid, start: session.hostStart };
    if (session.state === 'starting') {
      w.startingSince ??= at;
      return at - w.startingSince >= startingDeadlineMs
        ? { kind: 'start-deadline', task, sessionId }
        : null;
    }
    const quietMs = at - entry.lastAt;
    if (session.state === 'live') {
      if (!entry.turn || entry.permitWaiting || quietMs < silentAfterMs) return null;
      if (deps.permitPending?.(sessionId)) return null;
      if (waitsForHuman(task, session.stepId)) return null;
      return { kind: 'silent', task, sessionId, lastAt: entry.lastAt, id };
    }
    // quiet: ход кончился в тишине (`turn.ended` — живое событие, книга вернула бы live) не бывает;
    // ожидание человека, начатое в тишине, порог не жжёт.
    if (w.probedAt === entry.lastAt || waitsForHuman(task, session.stepId)) return null;
    const threshold = sessionStallThreshold(
      [...new Set(entry.pending.values())],
      deps.toolP95?.() ?? null,
      stallDefaultMs,
    );
    if (quietMs < threshold.ms) return null;
    return { kind: 'deadline', task, sessionId, lastAt: entry.lastAt, id, threshold };
  };

  const probeRow = (
    move: Extract<Move, { kind: 'deadline' }>,
    got: TreeProbe,
    at: number,
    baseline: number | null,
  ): Parameters<LiveTask['append']>[0] => {
    const cpuDeltaMs =
      typeof got.cpuMs === 'number' && typeof baseline === 'number'
        ? Math.round(got.cpuMs - baseline)
        : null;
    const basis =
      move.threshold.basis === 'learned' ? 'learned p95 x3, floor 2 min' : 'no learned p95';
    return {
      kind: 'session.probe',
      actor: 'core',
      sessionId: move.sessionId,
      stepId: move.task.state.sessions[move.sessionId]?.stepId,
      data: {
        sessionId: move.sessionId,
        verdict: got.verdict,
        cpuDeltaMs,
        quietMs: Math.max(0, Math.round(at - move.lastAt)),
        thresholdMs: Math.round(move.threshold.ms),
        toolClass: move.threshold.toolClass,
        reason: `host pid ${move.id.pid}; threshold: ${basis}; ${cpuSourceOf()}${
          cpuDeltaMs === null ? '; cpu baseline or reading missing' : ''
        }`,
      },
    } as Parameters<LiveTask['append']>[0];
  };

  const stopTree = async (task: LiveTask, sessionId: string): Promise<void> => {
    try {
      await stop(task, sessionId);
    } catch (error) {
      deps.note('observer.stall.stop-failed', {
        taskId: task.taskId,
        sessionId,
        reason: reasonOf(error),
      });
    }
  };

  /** Сессия ещё там, где её застал план, и за время пробы событий не было. */
  const still = (move: Move, state: string): boolean => {
    const session = move.task.state.sessions[move.sessionId];
    if (session?.state !== state) return false;
    if (move.kind === 'start-deadline') return true;
    return deps.activity.get(move.sessionId)?.lastAt === move.lastAt;
  };

  const apply = async (move: Move, got: TreeProbe | undefined, at: number): Promise<void> => {
    const { task, sessionId } = move;
    if (move.kind === 'start-deadline') {
      await stopTree(task, sessionId);
      if (!still(move, 'starting')) return;
      transition(task, sessionId, { event: 'deadline', from: 'starting', to: 'ended' });
      return;
    }
    if (move.kind === 'silent') {
      if (!still(move, 'live')) return;
      if (transition(task, sessionId, { event: 'silent', from: 'live', to: 'quiet' }))
        watch(sessionId).baselineCpu = got?.cpuMs ?? null;
      return;
    }
    if (!got || !still(move, 'quiet')) return;
    const w = watch(sessionId);
    w.probedAt = move.lastAt;
    if (!transition(task, sessionId, { event: 'deadline', from: 'quiet', to: 'quiet' })) return;
    append(task, probeRow(move, got, at, w.baselineCpu));
    if (got.verdict !== 'dead') return;
    await stopTree(task, sessionId);
    const now = task.state.sessions[sessionId]?.state;
    if (now && OPEN.has(now))
      transition(task, sessionId, { event: 'host-dead', from: now, to: 'lost' });
  };

  /**
   * Снять CLI, переживший хост. `null` — снят доказанно; иначе причина. Остановка не бросает на
   * выжившем: остаток приходит в `residual`, недоказанное — в `unknown`.
   */
  const stopOrphanOf = async (child: ProcessIdentity): Promise<string | null> => {
    try {
      const report = await stopOrphan(child);
      if (report.unknown !== undefined) return `not proven: ${report.unknown}`;
      if (report.residual.length > 0)
        return `still alive: ${report.residual.map((p) => p.pid).join(', ')}`;
      return null;
    } catch (error) {
      return reasonOf(error);
    }
  };

  /**
   * Хост сеанса доказанно мёртв без исхода: остаток дерева CLI снимается, сеанс — `lost`. `lost`
   * отпускает место шага (`dropSeat`), поэтому пишется только после доказанной смерти CLI: живая
   * сирота, оставшаяся после неудачной остановки, — работающий сеанс на этом месте (на POSIX CLI в
   * своей группе переживает хост). Следующая сверка (`hostCheckMs`) пробует снова.
   */
  const checkHost = async (task: LiveTask, sessionId: string): Promise<void> => {
    if (!OPEN.has(task.state.sessions[sessionId]?.state ?? '')) return;
    const got = await hostOf(task, sessionId);
    if (got.state !== 'lost') return;
    if (got.child && got.childAlive !== 'dead') {
      const failed = await stopOrphanOf(got.child);
      if (failed !== null) {
        const w = watch(sessionId);
        if (!w.orphanStopNoted)
          deps.note('observer.host.stop-failed', {
            taskId: task.taskId,
            sessionId,
            orphan: got.child.pid,
            reason: failed,
          });
        w.orphanStopNoted = true;
        return;
      }
    }
    // Между пробой и записью сеанс мог кончиться сам (строка `exited`): второй конец не пишется.
    const now = task.state.sessions[sessionId]?.state;
    if (!now || !OPEN.has(now)) return;
    if (transition(task, sessionId, { event: 'host-dead', from: now, to: 'lost' }))
      deps.note('observer.host-dead', {
        taskId: task.taskId,
        sessionId,
        hostPid: got.host.pid,
        orphan: got.child && got.childAlive !== 'dead' ? got.child.pid : null,
      });
  };

  const checkHosts = async (at: number, busy: ReadonlySet<string>): Promise<void> => {
    if (at - hostCheckedAt < hostCheckMs) return;
    hostCheckedAt = at;
    for (const task of tasks.values()) {
      for (const [sessionId, session] of Object.entries(task.state.sessions)) {
        // Сеанс, который этот тик уже пробует сроком, судит его проба.
        if (!OPEN.has(session.state) || busy.has(sessionId)) continue;
        try {
          await checkHost(task, sessionId);
        } catch (error) {
          deps.note('observer.host.failed', {
            taskId: task.taskId,
            sessionId,
            reason: reasonOf(error),
          });
        }
      }
    }
  };

  const pass = async (): Promise<void> => {
    const at = deps.now();
    const moves: Move[] = [];
    for (const task of tasks.values()) {
      for (const [sessionId, session] of Object.entries(task.state.sessions)) {
        if (!OPEN.has(session.state)) {
          if (watched.delete(sessionId)) deps.activity.forget(sessionId);
          continue;
        }
        const move = plan(task, sessionId, deps.activity.touch(sessionId), at);
        if (move) moves.push(move);
      }
    }
    const probed = moves.filter((m) => m.kind !== 'start-deadline');
    let results: TreeProbe[] = [];
    try {
      results = await probeTrees(
        deps.probe,
        probed.map((m) => m.id),
      );
    } catch (error) {
      deps.note('observer.stall.probe-failed', { reason: reasonOf(error) });
      results = probed.map(() => ({ verdict: 'unknown', cpuMs: null }));
    }
    const byMove = new Map<Move, TreeProbe>(probed.map((m, i) => [m, results[i]!]));
    for (const move of moves) {
      try {
        await apply(move, byMove.get(move), at);
      } catch (error) {
        deps.note('observer.stall.failed', {
          taskId: move.task.taskId,
          sessionId: move.sessionId,
          reason: reasonOf(error),
        });
      }
    }
    await checkHosts(at, new Set(moves.filter((m) => m.kind !== 'silent').map((m) => m.sessionId)));
  };

  const watcher: StallWatch = {
    attach(task) {
      tasks.set(task.taskId, task);
      enrol(task, deps.now());
    },
    detach(taskId) {
      const task = tasks.get(taskId);
      tasks.delete(taskId);
      if (!task) return;
      for (const sessionId of Object.keys(task.state.sessions)) {
        watched.delete(sessionId);
        deps.activity.forget(sessionId);
      }
    },
    tick() {
      running ??= pass().finally(() => {
        running = null;
      });
      return running;
    },
    start(everyMs) {
      const handle = setInterval(() => {
        void watcher.tick();
      }, everyMs);
      handle.unref?.();
      return () => clearInterval(handle);
    },
  };
  return watcher;
}
