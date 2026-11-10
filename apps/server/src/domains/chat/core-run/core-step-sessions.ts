import type { TaskListItem, TasksReply } from '@agentdeck/contracts/core/panel-api';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { CoreCaller } from '../../core-ask/core-ask.ts';

/**
 * Сеансы, которые ядро открыло под шаги задачи (разбор, план, работа, ревью…), — не разговоры
 * человека: Claude кладёт их транскрипты в `projects/` под id сеанса ядра (`--session-id`), и без
 * этого фильтра список чатов проекта показывал бы их строками «## task … ## step План». Место им —
 * дерево агентов задачи. Шаг `chat` (чат через ядро, чат перехвата) — разговор человека, он в
 * списке остаётся.
 */

export interface StepSessionsPort {
  /** Строки списка задач ядра (`GET /v1/tasks`): по `seq` видно, менялась ли задача. */
  tasks(): Promise<readonly Pick<TaskListItem, 'taskId' | 'seq'>[]>;
  /** `null` — задачи у ядра нет. */
  view(taskId: string): Promise<TaskView | null>;
}

export interface CoreStepSessions {
  /** Id сеансов шагов (не `chat`) всех задач ядра; ядро молчит — последнее известное множество. */
  ids(): Promise<ReadonlySet<string>>;
}

/** Сеансы шагов одной задачи: всё, кроме шага `chat`. Шаг, которого вид не знает, — тоже шаг. */
export function stepSessionIdsOf(view: TaskView): string[] {
  const kindOf = new Map(view.steps.map((step) => [step.stepId, step.stepKind]));
  return view.sessions
    .filter((session) => kindOf.get(session.stepId) !== 'chat')
    .map((session) => session.sessionId);
}

/** Список задач ядра тем же звонком, что у хода чата (bearer панели, сверка слушателя). */
export function coreTaskListOver(call: CoreCaller['call']): StepSessionsPort['tasks'] {
  return async () => {
    const res = await call({ method: 'GET', path: '/v1/tasks' });
    if (!res.ok) throw new Error(`core tasks: HTTP ${res.status}`);
    return ((await res.json()) as TasksReply).tasks;
  };
}

/** Сколько видов задач читается разом: первый список после старта панели читает их все. */
const VIEW_BATCH = 8;

export function createCoreStepSessions(port: StepSessionsPort): CoreStepSessions {
  /** Задача → её число журнала на последнем чтении и сеансы шагов: неизменная задача не читается. */
  const known = new Map<string, { seq: number; ids: readonly string[] }>();
  let flat: ReadonlySet<string> = new Set();
  /** Список спрашивают часто и разом (вкладка, телефон, поиск) — один обход на всех. */
  let inflight: Promise<ReadonlySet<string>> | null = null;

  async function refresh(): Promise<ReadonlySet<string>> {
    let tasks: readonly Pick<TaskListItem, 'taskId' | 'seq'>[];
    try {
      tasks = await port.tasks();
    } catch {
      return flat;
    }
    const stale = tasks.filter((task) => known.get(task.taskId)?.seq !== task.seq);
    for (let at = 0; at < stale.length; at += VIEW_BATCH) {
      await Promise.all(
        stale.slice(at, at + VIEW_BATCH).map(async (task) => {
          // Вид не прочитан (ядро упало посреди обхода) — прежние сеансы задачи остаются скрыты,
          // `seq` не обновлён, следующий список прочтёт задачу снова.
          const view = await port.view(task.taskId).catch(() => undefined);
          if (view === undefined) return;
          known.set(task.taskId, { seq: task.seq, ids: view ? stepSessionIdsOf(view) : [] });
        }),
      );
    }
    // Задачи, ушедшей из списка ядра (журнал не читается), уже не видно — её сеансы остаются
    // скрыты: строка шага в списке чатов не должна всплыть оттого, что ядро потеряло журнал.
    flat = new Set([...known.values()].flatMap((entry) => entry.ids));
    return flat;
  }

  return {
    ids() {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
