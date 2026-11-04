import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import type {
  LaunchOptions,
  Prepared,
  RoadSession,
  RoadStart,
  SessionEnd,
  SessionRoad,
} from '../session-road.ts';
import type {
  BriefSection,
  ConductorHooks,
  SessionEvents,
  SessionPort,
  StepCtx,
} from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона B этапа 4 — цикл дирижёра. Крючков у неё нет: напоминание, круг, срок и пауза — действия
 * самого `next` (`conductor/next`), а не вердикты на шве. Здесь же — порт сессии исполнителя
 * поверх дороги сессии ядра (03 §Launcher): та же дорога, что у сквозного прогона.
 */
export function loopHooks(_deps: ConductorWiringDeps): ConductorHooks {
  return {};
}

/** Сессия прежнего ядра, прикреплённая заново для шага (01 §Sessions at core death, P89). */
export interface ResumedSession {
  handle: SessionHandle;
  /** Сколько первых событий прикреплённого потока — история (F-105). */
  replayed?: number;
}

export interface RoadPortDeps {
  task: LiveTask;
  road: Pick<SessionRoad, 'prepare' | 'launch' | 'started' | 'attach' | 'contextFor'>;
  adapterOf(id: string): CliAdapter | undefined;
  /**
   * Запуск сессии шага: копия, бриф, запреты, окружение знает вызывающий; маршрут — из
   * `s.routing` (зона A). `null` — шагу запускать нечего (отказ называется в `note`).
   */
  startOf(s: StepCtx, sessionId: string, brief: BriefSection[]): RoadStart | null;
  /** Живая сессия прежнего ядра для шага — продолжает его вместо новой. */
  resumeOf?(stepId: string): ResumedSession | undefined;
  launch?: LaunchOptions;
  /** Каждое событие переходника — вызывающему (сквозной прогон считает их). */
  onEvent?(stepId: string, event: AdapterEvent): void;
  /** Поток сессии кончился (сама вышла или снята). */
  onEnded?(stepId: string, sessionId: string): void;
  /** Замер базы нового сеанса (G9, `baseAtStart`) — в фоне, запуск его не ждёт. */
  measureBase?(task: LiveTask, prepared: Prepared): boolean;
  note(event: string, data: Record<string, unknown>): void;
}

interface Open {
  handle: SessionHandle;
  adapter: CliAdapter;
  road: RoadSession;
  /** Кому идут события: сессию прикрепили раньше шага (шаг в `checking`) — шаг забирает её себе. */
  on: SessionEvents;
}

/** Порт сессии исполнителя на дороге ядра: запуск/прикрепление, отправка, остановка. */
export function roadSessionPort(deps: RoadPortDeps): SessionPort & {
  /** Итог остановки по id сессии — что дорога нашла на ней (ресурсы, остаток дерева). */
  ends: Map<string, SessionEnd>;
  /**
   * Снять всё, что порт ещё держит (`soft`): исполнитель не снимает сессию, кончившуюся сама, а
   * её остаток (порты, временный каталог, дерево) дорога ищет только на `end`.
   */
  release(): Promise<void>;
} {
  const open = new Map<string, Open>();
  const ends = new Map<string, SessionEnd>();

  const events = (stepId: string, to: () => SessionEvents | undefined) => {
    // Инструмент считается по запросу и результату: конец хода с открытым — не безопасная точка.
    const tools = new Set<string>();
    return (event: AdapterEvent): void => {
      deps.onEvent?.(stepId, event);
      const on = to();
      if (!on) return;
      if (event.type === 'turn.ended') on.turnEnded();
      else if (event.type === 'tool.requested' && !tools.has(event.toolUseId)) {
        tools.add(event.toolUseId);
        on.tool(1);
      } else if (event.type === 'tool.result' && tools.delete(event.toolUseId)) on.tool(-1);
    };
  };

  const end = async (sessionId: string, mode: 'soft' | 'tree'): Promise<void> => {
    const o = open.get(sessionId);
    if (!o) return;
    open.delete(sessionId);
    // Остановка дорогой: порты до, временный каталог и остаток дерева после — в журнал задачи.
    const stop = await o.road.end(mode);
    ends.set(sessionId, stop);
    deps.note('session.end', {
      sessionId,
      how: stop.stop.how,
      found: stop.found.map((f) => f.kind),
      unread: stop.unread,
    });
  };

  return {
    ends,
    async open(s, brief, on) {
      const resumed = deps.resumeOf?.(s.stepId);
      // Та же сессия уже прикреплена (до шага, пока он ждал проверки): второго прикрепления нет —
      // события переходят к новому владельцу, бриф уйдёт ключом дубля.
      const held = resumed ? open.get(resumed.handle.sessionId) : undefined;
      if (held) {
        held.on = on;
        return { ok: true, sessionId: held.handle.sessionId, resumed: true };
      }
      let handle: SessionHandle;
      let start: RoadStart | null;
      if (resumed) {
        handle = resumed.handle;
        start = deps.startOf(s, handle.sessionId, brief);
      } else {
        start = deps.startOf(s, newId(), brief);
        if (!start) return { ok: false, reason: 'no session start for this step' };
        const prepared = await deps.road.prepare(start);
        if (!prepared.ok) return { ok: false, reason: `session road refused: ${prepared.reason}` };
        const got = await deps.road.launch(prepared.prepared, deps.launch);
        if (!got.ok) return { ok: false, reason: got.reason };
        handle = got.handle;
        try {
          deps.road.started(prepared.prepared, handle, got.layer);
        } catch (error) {
          // Процесс уже идёт, а журнал его не принял: без строки сессии её никто не снимет —
          // дерево снимается здесь, шаг получает отказ, а не сироту.
          await deps.adapterOf(start.adapterId)?.stop(handle, 'tree');
          return { ok: false, reason: `session not journaled: ${String(error)}` };
        }
        deps.measureBase?.(deps.task, prepared.prepared);
      }
      if (!start) return { ok: false, reason: 'no session start for this step' };
      const adapter = deps.adapterOf(start.adapterId);
      if (!adapter) return { ok: false, reason: `adapter ${start.adapterId} not registered` };
      const sessionId = handle.sessionId;
      // Получатель событий — до прикрепления: история потока может прийти прямо из `attach`.
      const target = { on };
      // Судья решает по тем же запретам, что оверлей CLI получил при запуске (F-11).
      const road = deps.road.attach({
        task: deps.task,
        sessionId,
        adapter,
        handle,
        context: deps.road.contextFor(start),
        cwd: start.cwd,
        resumed: resumed !== undefined,
        ...(resumed?.replayed === undefined ? {} : { replayed: resumed.replayed }),
        onEvent: events(s.stepId, () => target.on),
      });
      const entry: Open = Object.assign(target, { handle, adapter, road });
      void road.done.then(() => {
        deps.onEnded?.(s.stepId, sessionId);
        entry.on.ended();
      });
      open.set(sessionId, entry);
      return { ok: true, sessionId, resumed: resumed !== undefined };
    },
    async send(sessionId, text, cmdId, origin = 'platform', images) {
      const o = open.get(sessionId);
      if (!o) return;
      const sent =
        images && images.length > 0
          ? await o.adapter.send(o.handle, text, cmdId, origin, images)
          : await o.adapter.send(o.handle, text, cmdId, origin);
      deps.note('session.sent', { sessionId, cmdId, origin, dup: sent.dup });
    },
    end,
    async release() {
      for (const sessionId of [...open.keys()]) await end(sessionId, 'soft');
    },
  };
}
