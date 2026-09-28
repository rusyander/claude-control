import type { ChatProgress, ProgressActiveTool } from '@agentdeck/contracts';

/**
 * Шапка прогресса одной строкой данных — без React, чтобы проверяться тестом.
 *
 * Раньше шапка несла только «Субагентов: N»: работает ли кто-то из них, с
 * телефона понять было нельзя, хотя ради этого на ход и смотрят (живой прогон
 * 28.09, 1b). Субагент «идёт» только пока идёт сам прогон: законченный ход
 * своих субагентов уже не ведёт, и «работают 1» у молчащего чата было бы
 * враньём.
 */
export interface ProgressHead {
  done: number;
  total: number;
  /** Текущий пункт плана — главнее всего остального. */
  current?: string;
  running: number;
  finished: number;
  /** Вызов без результата — только у идущего прогона. */
  activeTool?: ProgressActiveTool;
}

export function progressHead(progress: ChatProgress, isRunning: boolean): ProgressHead {
  const tasks = progress.tasks ?? [];
  const agents = progress.agents ?? [];
  const running = isRunning ? agents.filter((agent) => agent.status === 'running').length : 0;
  return {
    done: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
    current: tasks.find((task) => task.status === 'in_progress')?.text,
    running,
    finished: agents.length - running,
    activeTool: isRunning ? progress.activeTool : undefined,
  };
}
