import type { CommandKind, CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { SessionStreamPage } from '@agentdeck/contracts/core/session-stream';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { CoreChatPort } from '../core-run.types.ts';

/**
 * Ядро на границе панели для тестов маршрутов: настоящий `CoreChatRun` над этим портом ведёт ход
 * как над ядром (оценка → команды → шаг `chat` → сеанс → поток), а тест видит, ЧТО панель отдала
 * ядру. Поведение задачи выбирает тест по тексту запроса (`behave`): отказ шага до сеанса, сеанс
 * позже срока. Конец хода — только по `finish()`: «прогон ещё идёт» — состояние, а не гонка.
 */

/** Как ядро ведёт задачу, заведённую оценкой с этим запросом. */
export interface StubCoreBehaviour {
  /** Шаг кончается неудачей без сеанса — причина ядра дословно. */
  stepFailed?: string;
  /** Сеанс шага появляется в виде задачи не раньше, чем через столько мс после запуска. */
  sessionAfterMs?: number;
}

export interface StubCoreCall {
  taskId: string;
  kind: CommandKind;
  fields: Record<string, unknown>;
}

interface StubTask {
  taskId: string;
  sessionId: string;
  behaviour: StubCoreBehaviour;
  launchedAt?: number;
}

export interface StubCorePort {
  port: CoreChatPort;
  estimates: EstimateFields[];
  calls: StubCoreCall[];
  /** Ядро пишет конец хода во все открытые сеансы. */
  finish(): void;
}

export function stubCorePort(
  options: {
    /** Id сеанса задачи (первой — как есть, следующих — с номером). */
    sessionId?: string;
    behave?: (request: string) => StubCoreBehaviour;
  } = {},
): StubCorePort {
  const tasks = new Map<string, StubTask>();
  const estimates: EstimateFields[] = [];
  const calls: StubCoreCall[] = [];
  let finished = false;
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const task = (taskId: string): StubTask => {
    const found = tasks.get(taskId);
    if (!found) throw new Error(`stub core: unknown task ${taskId}`);
    return found;
  };
  const hasSession = (t: StubTask): boolean =>
    t.launchedAt !== undefined &&
    !t.behaviour.stepFailed &&
    Date.now() - t.launchedAt >= (t.behaviour.sessionAfterMs ?? 0);
  const page = (t: StubTask, events: SessionStreamPage['events']): SessionStreamPage => ({
    taskId: t.taskId,
    sessionId: t.sessionId,
    adapter: 'claude',
    events,
    next: events.length ? (events.at(-1)?.offset ?? 0) + 1 : 1,
    done: false,
  });

  const port: CoreChatPort = {
    async estimate(fields) {
      estimates.push(fields);
      const n = tasks.size;
      const taskId = `stub-task-${n + 1}`;
      const base = options.sessionId ?? 'stub-session';
      tasks.set(taskId, {
        taskId,
        sessionId: n === 0 ? base : `${base}-${n + 1}`,
        behaviour: options.behave?.(fields.request) ?? {},
      });
      return { ok: true, taskId };
    },
    async attach() {
      return { ok: false, code: 'unsupported', message: 'stub core: no attachments' };
    },
    async command(taskId, kind, fields) {
      calls.push({ taskId, kind, fields });
      if (kind === 'launch') task(taskId).launchedAt = Date.now();
      return { cmdId: `c${calls.length}`, status: 'applied', seq: calls.length } as CommandOutcome;
    },
    async view(taskId) {
      const t = tasks.get(taskId);
      if (!t) return null;
      const failed = t.behaviour.stepFailed;
      return {
        taskId,
        ended: null,
        steps:
          t.launchedAt === undefined
            ? []
            : [
                {
                  stepId: `${taskId}-chat`,
                  stepKind: 'chat',
                  state: failed ? 'failed' : 'running',
                  startedSeq: 1,
                  outcome: failed ? 'failed' : null,
                  reason: failed ?? null,
                },
              ],
        sessions: hasSession(t)
          ? [{ sessionId: t.sessionId, stepId: `${taskId}-chat`, startedSeq: 2 }]
          : [],
        asks: [],
      } as unknown as TaskView;
    },
    async page(taskId) {
      return page(task(taskId), []);
    },
    async *follow(taskId, _sessionId, _from, signal) {
      const t = task(taskId);
      yield page(t, []);
      while (!finished && !signal.aborted) {
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (signal.aborted) return;
      yield page(t, [{ kind: 'turn-end', data: { isError: false, numTurns: 1 }, offset: 10 }]);
      // Живой сеанс после конца хода не закрывается сам: поток висит до обрыва.
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    // Журнал задачи без вопросов права: поток молчит до обрыва.
    taskEvents: (_taskId, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        yield* [];
      },
    }),
  };
  return {
    port,
    estimates,
    calls,
    finish() {
      finished = true;
      wake();
    },
  };
}
