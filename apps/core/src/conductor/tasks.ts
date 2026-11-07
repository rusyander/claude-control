import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { listDir } from '../platform/safe-io/files.ts';
import { readTaskView } from '../journal/read-view.ts';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { createTask, resume, type LiveTask, type ResumeDeps } from '../journal/resume.ts';
import { endUnclosed } from './run/close.ts';
import { join } from 'node:path';

/**
 * Задачи этого ядра: живые (аренда у нас, запись идёт) и прочие (только чтение свёртки). При
 * загрузке ядро открывает каждую незаконченную задачу через один `resume()` — других путей
 * к состоянию нет (P11). Задача, чья аренда у другого живого ядра, остаётся «чужой» и видна
 * только для чтения.
 */

export interface TaskSummary {
  taskId: string;
  live: boolean;
  seq: number;
  state: TaskFoldState['task'];
  ended: TaskFoldState['ended'];
  title: string | null;
  /** Задача требует человека: журнал не открылся или сверка упала при загрузке (ревью F-49). */
  attention: string | null;
  /** Этап 11 (W3-18): группа задачи из `task.created` — в каждой строке списка, без второго чтения. */
  groupId?: string;
  /** Этап 11 (W3-18): родитель дочерней задачи XL (`task.created.parentTaskId`). */
  parentTaskId?: string;
}

export interface TaskRegistry {
  readonly tasksDir: string;
  /** Маска DLP писателя журналов: суд до открытия сравнивает повтор команды так же (F-25). */
  readonly mask: ResumeDeps['mask'];
  list(): TaskSummary[];
  view(taskId: string): TaskFoldState | undefined;
  /** Причина «нужен человек» (`flag`), та же, что в списке; `null` — задача не помечена. */
  attentionOf(taskId: string): string | null;
  live(taskId: string): LiveTask | undefined;
  liveTasks(): LiveTask[];
  /** Живая задача: уже открытая или открытая сейчас; аренда у другого — `undefined` + причина. */
  open(taskId: string): Promise<{ task: LiveTask } | { refused: string }>;
  /** Незаконченные: идущие и кончившиеся без отчёта конца (`endUnclosed`, крах до закрытия). */
  openUnfinished(): Promise<{ opened: string[]; refused: { taskId: string; reason: string }[] }>;
  create(created: JournalDataV1['task.created']): Promise<LiveTask>;
  /** Аренда потеряна (перехват): задача больше не наша. */
  drop(taskId: string): void;
  /**
   * Пометить задачу «нужен человек» с причиной (ревью F-49): одна задача, чей журнал не открылся
   * или чья сверка упала, не роняет загрузку — она отделяется и видна в списке.
   */
  flag(taskId: string, reason: string): void;
  /**
   * Следить за задачей: `live` — её открыли (создали) в этом ядре, `gone` — она ушла из живых
   * (аренда потеряна, закрытие). Поток событий без этого не видел задачу, открытую после
   * подписки (ревью M2). Ответ — отписка.
   */
  watch(taskId: string, handlers: TaskWatcher): () => void;
  closeAll(): void;
}

export interface TaskWatcher {
  live(task: LiveTask): void;
  gone(): void;
}

function summary(
  taskId: string,
  state: TaskFoldState,
  live: boolean,
  attention: string | null,
): TaskSummary {
  return {
    taskId,
    live,
    seq: state.seq,
    state: state.task,
    ended: state.ended,
    title: state.created?.title ?? null,
    attention,
    ...(state.created?.groupId ? { groupId: state.created.groupId } : {}),
    ...(state.created?.parentTaskId ? { parentTaskId: state.created.parentTaskId } : {}),
  };
}

const OPEN_FAILED = 'journal did not open';

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface TaskRegistryHooks {
  /**
   * Задача стала живой в этом ядре (открыта или создана) — до подписчиков `watch` и до первой
   * записи после открытия: наблюдатель (этап 8) подписывается на каждую, не пропуская строк.
   */
  onLive?(task: LiveTask): void;
}

export function createTaskRegistry(
  tasksDir: string,
  deps: ResumeDeps,
  hooks: TaskRegistryHooks = {},
): TaskRegistry {
  const live = new Map<string, LiveTask>();
  const attention = new Map<string, string>();
  const watchers = new Map<string, Set<TaskWatcher>>();
  // Копия набора: наблюдатель может отписаться прямо из своего вызова (поток закрылся).
  const notify = (taskId: string, call: (watcher: TaskWatcher) => void): void => {
    for (const watcher of [...(watchers.get(taskId) ?? [])]) call(watcher);
  };
  const ids = (): string[] => {
    const read = listDir(tasksDir);
    // Нечитаемый каталог задач — отказ с причиной, а не «задач нет»: иначе загрузка молча не
    // открыла бы ни одной незаконченной задачи (P44).
    if ('unknown' in read) throw new Error(`tasks dir unreadable: ${read.unknown}`);
    return 'value' in read ? read.value.filter(isUuidv7).sort() : [];
  };
  const viewOf = (taskId: string): TaskFoldState | undefined => {
    const own = live.get(taskId);
    if (own) return own.state;
    if (!ids().includes(taskId)) return undefined;
    return readTaskView(join(tasksDir, taskId), taskId).state;
  };
  type Opened = { task: LiveTask } | { refused: string };
  const opening = new Map<string, Promise<Opened>>();
  const openOnce = async (taskId: string): Promise<Opened> => {
    if (!ids().includes(taskId)) return { refused: 'no such task' };
    const outcome = await resume(join(tasksDir, taskId), taskId, {
      ...deps,
      onLeaseLost: (id) => {
        registry.drop(id);
        deps.onLeaseLost?.(id);
      },
    });
    if (!outcome.ok) return { refused: outcome.reason };
    // Журнал открылся позже (файл отпустили) — пометка «не открылся» больше не правда.
    if (attention.get(taskId)?.startsWith(OPEN_FAILED)) attention.delete(taskId);
    live.set(taskId, outcome.task);
    hooks.onLive?.(outcome.task);
    notify(taskId, (watcher) => watcher.live(outcome.task));
    return { task: outcome.task };
  };
  const registry: TaskRegistry = {
    tasksDir,
    mask: deps.mask,
    list() {
      return ids().flatMap((taskId) => {
        const own = live.get(taskId);
        const flagged = attention.get(taskId) ?? null;
        if (own) return [summary(taskId, own.state, true, flagged)];
        try {
          const state = readTaskView(join(tasksDir, taskId), taskId).state;
          return [summary(taskId, state, false, flagged)];
        } catch {
          // Нечитаемый журнал не прячет остальные задачи: список отдаёт читаемые, а сама
          // задача по своему адресу отвечает ошибкой с причиной.
          return [];
        }
      });
    },
    view: viewOf,
    attentionOf: (taskId) => attention.get(taskId) ?? null,
    live: (taskId) => live.get(taskId),
    liveTasks: () => [...live.values()],
    open(taskId) {
      const own = live.get(taskId);
      if (own) return Promise.resolve({ task: own });
      // Два запроса к ещё не открытой задаче разом: второй ждёт первого, а не спорит с ним за
      // аренду (своя же аренда для второго — «занято»).
      const pending = opening.get(taskId);
      if (pending) return pending;
      const started = openOnce(taskId).finally(() => opening.delete(taskId));
      opening.set(taskId, started);
      return started;
    },
    async openUnfinished() {
      const opened: string[] = [];
      const refused: { taskId: string; reason: string }[] = [];
      for (const taskId of ids()) {
        let finished: boolean;
        try {
          const state = readTaskView(join(tasksDir, taskId), taskId).state;
          // Кончилась без отчёта конца (крах между концом и закрытием) — не закончена: её конец
          // закрывает обход исполнителя этого ядра, ровно раз.
          finished = state.ended !== null && !endUnclosed(state);
        } catch (error) {
          refused.push({ taskId, reason: reasonOf(error) });
          registry.flag(taskId, `journal unreadable: ${reasonOf(error)}`);
          continue;
        }
        if (finished) continue;
        let got: Opened;
        try {
          got = await registry.open(taskId);
        } catch (error) {
          // Журнал читается, но не открывается на запись (антивирус, бэкап держит файл): эта
          // задача отделяется, остальные открываются (ревью F-49 — раньше падала вся загрузка).
          refused.push({ taskId, reason: reasonOf(error) });
          registry.flag(taskId, `${OPEN_FAILED}: ${reasonOf(error)}`);
          continue;
        }
        if ('task' in got) opened.push(taskId);
        else refused.push({ taskId, reason: got.refused });
      }
      return { opened, refused };
    },
    async create(created) {
      const task = await createTask(tasksDir, created, {
        ...deps,
        onLeaseLost: (id) => {
          registry.drop(id);
          deps.onLeaseLost?.(id);
        },
      });
      live.set(task.taskId, task);
      hooks.onLive?.(task);
      notify(task.taskId, (watcher) => watcher.live(task));
      return task;
    },
    drop(taskId) {
      const task = live.get(taskId);
      live.delete(taskId);
      try {
        // Аренда уже чужая: `close` не пишет (`holds()` ложно) и снимает только свои ресурсы.
        task?.close();
      } catch {
        // Закрытие потерянной задачи не может уронить таймер ударов, из которого его зовут.
      }
      if (task) notify(taskId, (watcher) => watcher.gone());
    },
    flag(taskId, reason) {
      attention.set(taskId, reason);
    },
    watch(taskId, handlers) {
      const set = watchers.get(taskId) ?? new Set<TaskWatcher>();
      set.add(handlers);
      watchers.set(taskId, set);
      return () => {
        set.delete(handlers);
        if (set.size === 0 && watchers.get(taskId) === set) watchers.delete(taskId);
      };
    },
    closeAll() {
      for (const task of live.values()) {
        try {
          task.close();
        } catch {
          // Закрытие одной задачи (аренду уже перехватили) не мешает закрыть остальные.
        }
      }
      const closed = [...live.keys()];
      live.clear();
      for (const taskId of closed) notify(taskId, (watcher) => watcher.gone());
    },
  };
  return registry;
}
