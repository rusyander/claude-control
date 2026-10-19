import type { ChatProgress } from '@agentdeck/contracts';
import { groupStep } from './groupStep';
import type { GroupProgressInput, GroupProgressView } from './groupProgress.types';

/**
 * Индикатор группы в хабе (19.10.2026): сколько сделано из скольких, в каком
 * состоянии группа и с каких пор, чем занята прямо сейчас. Только из того, что
 * действительно известно: файл шагов и план агента — для «сделано», запрос
 * прав, билет очереди тяжёлых шагов и незакрытый вызов — для состояния. Нет
 * ни плана, ни файла шагов — полосы нет, а не выдуманные проценты.
 */
export function groupProgress({
  progress,
  group,
  permission,
}: GroupProgressInput): GroupProgressView {
  const step = groupStep(progress, group.isRunning);
  const finished = group.status === 'done' || group.mrClosed === 'merged';
  const counted = doneOf(progress, finished);
  // Незакрытый вызов стоящей группы — то, на чём она когда-то оборвалась, а не
  // то, что идёт; у ждущей прав это ровно тот вызов, что ждёт решения.
  const tool = group.isRunning || permission ? progress?.activeTool : undefined;
  const state = stateOf(permission, group.isRunning, Boolean(progress?.heavyQueue), finished);
  const since = sinceOf(state, progress, group);
  return {
    state,
    ...(since ? { since } : {}),
    ...(counted
      ? {
          done: counted.done,
          total: counted.total,
          percent: Math.round((counted.done / counted.total) * 100),
        }
      : {}),
    ...(step ? { step } : {}),
    ...(tool ? { tool } : {}),
    ...(state === 'queued' && progress?.heavyQueue
      ? { queueAhead: progress.heavyQueue.ahead }
      : {}),
  };
}

/** Запрос прав сильнее всего: он ждёт человека, даже когда прогон числится идущим. */
function stateOf(
  permission: boolean,
  isRunning: boolean,
  queued: boolean,
  finished: boolean,
): GroupProgressView['state'] {
  if (permission) return 'permission';
  if (isRunning) return queued ? 'queued' : 'working';
  return finished ? 'finished' : 'stalled';
}

/**
 * Сделано из скольких. Файл шагов называет шаг, который ИДЁТ, — сделано на один
 * меньше, пока группа не закончила; план агента считает закрытые пункты прямо.
 */
function doneOf(
  progress: ChatProgress | undefined,
  finished: boolean,
): { done: number; total: number } | undefined {
  const steps = progress?.steps;
  if (steps && steps.total > 0) {
    const done = finished ? steps.current : steps.current - 1;
    return { done: clamp(done, steps.total), total: steps.total };
  }
  const tasks = progress?.tasks ?? [];
  if (tasks.length === 0) return undefined;
  const done = tasks.filter((task) => task.status === 'completed').length;
  return { done, total: tasks.length };
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/**
 * С каких пор группа в этом состоянии: запрос прав висит со своего вызова,
 * очередь — с билета, работа — с заведения цепочки, остановка — с последней
 * записи. Чего не знаем — того не показываем.
 */
function sinceOf(
  state: GroupProgressView['state'],
  progress: ChatProgress | undefined,
  group: GroupProgressInput['group'],
): string | undefined {
  if (state === 'permission') return progress?.activeTool?.startedAt;
  if (state === 'queued') return progress?.heavyQueue?.since;
  if (state === 'working') return group.startedAt;
  return group.lastAt;
}
