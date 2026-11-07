import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { linesAfter } from '../../journal/read-view.ts';
import { initAgentsFold, stepAgents, type AgentsFold } from '../../journal/reduce/agents-view.ts';

/**
 * Свёртки истории агентов по задачам (этап 11, P146): одна на задачу, догоняется по файлу
 * журнала (`linesAfter` после своего `seq`), живая задача — ещё и подпиской. Строка с разрывом
 * номера (подписка опередила чтение) сначала догоняет пропущенное из файла: свёртка не теряет
 * строк. Кончившиеся задачи не держатся вечно — кэш ограничен.
 */

/** Свёрток не живых задач в памяти; старшие вытесняются (их пересоберёт следующее чтение). */
const IDLE_FOLDS = 64;

export interface FoldBook {
  /** Свёртка задачи, догнанная до конца файла; `undefined` — задачи нет. */
  of(taskId: string): AgentsFold | undefined;
  /**
   * Подписать живую задачу (повтор ничего не делает); `onLine` — после каждой свёрнутой строки.
   * Ответ — свёртка подписки: её ведёт подписка, файл заново не читается.
   */
  follow(task: LiveTask, onLine: (fold: AgentsFold, line: JournalLine) => void): AgentsFold;
  /** Снять подписки задач, ушедших из живых. */
  prune(live: readonly string[]): void;
  close(): void;
}

export function createFoldBook(registry: TaskRegistry): FoldBook {
  const folds = new Map<string, AgentsFold>();
  /** Подписка — на тот объект живой задачи, на который подписались: открытая заново — другой. */
  const subs = new Map<string, { task: LiveTask; off: () => void }>();
  const dirOf = (taskId: string): string => join(registry.tasksDir, taskId);

  const catchUp = (fold: AgentsFold, beforeSeq = Number.POSITIVE_INFINITY): void => {
    for (const line of linesAfter(dirOf(fold.taskId), fold.taskId, fold.seq)) {
      if (line.seq >= beforeSeq) break;
      stepAgents(fold, line);
    }
  };

  const remember = (taskId: string, fold: AgentsFold): void => {
    folds.delete(taskId);
    folds.set(taskId, fold);
    if (folds.size <= IDLE_FOLDS + subs.size) return;
    for (const id of folds.keys()) {
      if (subs.has(id)) continue;
      folds.delete(id);
      if (folds.size <= IDLE_FOLDS + subs.size) break;
    }
  };

  const of = (taskId: string): AgentsFold | undefined => {
    if (!registry.view(taskId)) return undefined;
    const fold = folds.get(taskId) ?? initAgentsFold(taskId);
    catchUp(fold);
    remember(taskId, fold);
    return fold;
  };

  return {
    of,
    follow(task, onLine) {
      const known = folds.get(task.taskId);
      const sub = subs.get(task.taskId);
      if (known && sub?.task === task) return known;
      // Старый объект (аренда потеряна, задача открыта снова) строк больше не даст: подписка —
      // заново, пропущенное между ними свёртка догонит из файла.
      sub?.off();
      subs.delete(task.taskId);
      const fold = of(task.taskId) ?? initAgentsFold(task.taskId);
      const off = task.subscribe((line) => {
        if (line.seq <= fold.seq) return;
        // Разрыв: строки между свёрткой и этой ещё не свёрнуты — догнать их из файла.
        if (line.seq > fold.seq + 1) catchUp(fold, line.seq);
        stepAgents(fold, line);
        onLine(fold, line);
      });
      subs.set(task.taskId, { task, off });
      folds.set(task.taskId, fold);
      return fold;
    },
    prune(live) {
      for (const [taskId, sub] of subs) {
        if (live.includes(taskId)) continue;
        sub.off();
        subs.delete(taskId);
      }
    },
    close() {
      for (const sub of subs.values()) sub.off();
      subs.clear();
      folds.clear();
    },
  };
}
