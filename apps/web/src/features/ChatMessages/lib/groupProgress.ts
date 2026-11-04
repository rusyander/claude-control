import type { ChatProgress } from '@agentdeck/contracts';
import { groupStep } from './groupStep';
import type { GroupProgressInput, GroupProgressView } from './groupProgress.types';

/**
 * Индикатор группы в хабе (19.10.2026): сколько сделано из скольких, в каком
 * состоянии группа и с каких пор, чем занята прямо сейчас. Только из того, что
 * действительно известно: файл шагов и план агента — для «сделано», запрос
 * прав и незакрытый вызов — для состояния. Нет
 * ни плана, ни файла шагов — полосы нет, а не выдуманные проценты.
 */
export function groupProgress({
  progress,
  group,
  permission,
}: GroupProgressInput): GroupProgressView {
  const step = groupStep(progress, group.isRunning);
  const counted = doneOf(progress);
  // Незакрытый вызов стоящей группы — то, на чём она когда-то оборвалась, а не
  // то, что идёт; у ждущей прав это ровно тот вызов, что ждёт решения.
  const tool = group.isRunning || permission ? progress?.activeTool : undefined;
  const state = stateOf(permission, group.isRunning);
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
  };
}

/** Запрос прав сильнее всего: он ждёт человека, даже когда прогон числится идущим. */
function stateOf(permission: boolean, isRunning: boolean): GroupProgressView['state'] {
  if (permission) return 'permission';
  return isRunning ? 'working' : 'stalled';
}

/**
 * Сделано из скольких. Файл шагов называет шаг, который ИДЁТ, — сделано на один
 * меньше; план агента считает закрытые пункты прямо.
 */
function doneOf(progress: ChatProgress | undefined): { done: number; total: number } | undefined {
  const steps = progress?.steps;
  if (steps && steps.total > 0) {
    const done = steps.current - 1;
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
 * работа — со старта идущего хода, остановка — с последней
 * записи. Чего не знаем — того не показываем: заведение цепочки работой не
 * считается (живой прогон 20.10: группа, продолженная через сутки, «работала
 * 21ч 09м» при часе работы).
 */
function sinceOf(
  state: GroupProgressView['state'],
  progress: ChatProgress | undefined,
  group: GroupProgressInput['group'],
): string | undefined {
  if (state === 'permission') return progress?.activeTool?.startedAt;
  if (state === 'working') return group.runStartedAt;
  return group.lastAt;
}
