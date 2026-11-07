import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PredicateCtx } from '../../observer/observer.types.ts';
import { createLivenessProbe } from '../../platform/process-identity.ts';
import { createActivityBook, UNCLASSIFIED_TOOL, type ToolClassOf } from './activity.ts';
import { attachObserver, type ObserverAttachment } from './attach.ts';
import { effectOf, POLL_TOOLS } from './effect-class.ts';
import { createRejectedSink, type RejectedSink } from './integrity.ts';
import type { ObserverNote, ObserverOptions, ObserverTap } from './observer-wiring.types.ts';
import { createStallWatch } from './stall.ts';
import { createToolEventTap, type ToolEventSession } from './tool-events.ts';

export type { ObserverNote, ObserverOptions, ObserverTap } from './observer-wiring.types.ts';
export { attachObserver, type ObserverAttachment } from './attach.ts';

/**
 * Проводка наблюдателя (этап 8): один кран потока сессий — факты вызовов (зона W `tool-events`)
 * и книга активности (зона T `activity`), — подписчик на каждую живую задачу ядра, сторож тишины
 * по тику (зона T `stall`) и приёмник отказов писателя журнала (зона I, `journal-rejected`).
 */

/** Краны по порядку; сбой одного — запись в журнал ядра, прочие идут дальше. */
export function composeTaps(taps: readonly ObserverTap[], note: ObserverNote): ObserverTap {
  return {
    onEvent(task, binding, event, meta) {
      for (const tap of taps) {
        try {
          tap.onEvent(task, binding, event, meta);
        } catch (error) {
          note('observer.tap.failed', {
            taskId: binding.taskId,
            sessionId: binding.sessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}

/** Шаг тика сторожа тишины по умолчанию: тишина меряется секундами, проба — один снимок на тик. */
export const STALL_TICK_MS = 1_000;

export interface ObserverWiringDeps {
  note: ObserverNote;
  /**
   * Окно контекста маршрута × модели в токенах — книга окон загрузки (`route-windows.ts`, та же у
   * правила 60 % продолжения); нет — `null` для всех.
   */
  windowOf?: (routeId: string, model: string | null) => number | null;
  /** Рабочее монотонное время; читается на каждый вызов — тикающие часы появляются позже загрузки. */
  now: () => number;
  options?: ObserverOptions;
  /**
   * Сопоставление переходника и корень копии прикреплённой сессии (рантайм сессий). Нет или
   * `undefined` — факт вызова не пишется, класс ожидаемого инструмента — общий `tool`.
   */
  sessionOf?: (task: LiveTask, binding: SessionBinding) => ToolEventSession | undefined;
  /** Выученные p95 вызова по классу действия (экономика загрузки); нет — порог спеки. */
  toolP95?: () => Readonly<Record<string, number>> | null;
  /** Вопрос о праве сессии ждёт решения ядра вне потока (`SessionRuntime.permitPending`). */
  permitPending?: (sessionId: string) => boolean;
  /** Шаг тика сторожа тишины; `0` — без таймера (проверки зовут `tick`). */
  tickEveryMs?: number;
}

export interface ObserverWiring {
  tap: ObserverTap;
  /** Подписать наблюдателя на живую задачу; открытая заново задача заменяет прежнюю подписку. */
  attach(task: LiveTask): void;
  /** Отказ писателя журнала задачи → сигнал `journal-rejected` (крючок `ResumeDeps.onRejected`). */
  rejected: RejectedSink;
  /** Один проход сторожа тишины (тот же, что по таймеру). */
  tick(): Promise<void>;
  /** Снять все подписки и таймер (остановка ядра). */
  stop(): void;
}

const asInput = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

export function createObserverWiring(deps: ObserverWiringDeps): ObserverWiring {
  const ctx: PredicateCtx = {
    windowOf: (routeId, model) => deps.windowOf?.(routeId, model) ?? null,
    now: () => deps.now(),
  };
  const options = deps.options ?? {};
  const sessionOf = deps.sessionOf ?? (() => undefined);
  // Класс ожидаемого вызова — тот же словарь, что `tool.event.effectClass` и ключи выученного p95.
  const classOf: ToolClassOf = (task, binding, call) => {
    const session = sessionOf(task, binding);
    if (!session) return UNCLASSIFIED_TOOL;
    const ask = session.mapPermission({ tool: call.tool, input: asInput(call.input) });
    return effectOf(ask, { cwd: session.cwd, pollTools: POLL_TOOLS }).effectClass;
  };
  const activity = createActivityBook({ now: deps.now, note: deps.note, classOf });
  const toolEvents = createToolEventTap({ sessionOf, now: deps.now, pollTools: POLL_TOOLS });
  const stall = createStallWatch({
    activity,
    now: deps.now,
    probe: options.probe ?? createLivenessProbe(),
    toolP95: () => deps.toolP95?.() ?? null,
    note: deps.note,
    options: {
      ...(options.silentAfterMs === undefined ? {} : { silentAfterMs: options.silentAfterMs }),
      ...(options.stallDefaultMs === undefined ? {} : { stallDefaultMs: options.stallDefaultMs }),
      ...(options.hostCheckMs === undefined ? {} : { hostCheckMs: options.hostCheckMs }),
    },
    ...(deps.permitPending ? { permitPending: deps.permitPending } : {}),
  });
  const attached = new Map<string, { task: LiveTask; observer: ObserverAttachment }>();
  const rejected = createRejectedSink({
    taskOf: (taskId) => attached.get(taskId)?.task,
    note: deps.note,
  });
  const tickEveryMs = deps.tickEveryMs ?? STALL_TICK_MS;
  const stopTimer = tickEveryMs > 0 ? stall.start(tickEveryMs) : () => {};

  const detach = (taskId: string): void => {
    const was = attached.get(taskId);
    if (!was) return;
    attached.delete(taskId);
    was.observer.detach();
    stall.detach(taskId);
  };

  return {
    tap: composeTaps([toolEvents, activity.tap], deps.note),
    attach(task) {
      detach(task.taskId);
      try {
        attached.set(task.taskId, {
          task,
          observer: attachObserver(task, { ctx, note: deps.note }),
        });
      } catch (error) {
        // Журнал не прочитался для пересборки: задача живёт без наблюдателя, это видно.
        deps.note('observer.attach.failed', {
          taskId: task.taskId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      stall.attach(task);
    },
    rejected,
    tick: () => stall.tick(),
    stop() {
      stopTimer();
      for (const taskId of [...attached.keys()]) detach(taskId);
    },
  };
}
