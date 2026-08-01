import type { ChatProgress } from '@claude-control/contracts';

/**
 * Чистая выжимка для шапки панели прогресса. Вынесена из компонента, чтобы
 * считалась и проверялась отдельно от разметки: «сколько сделано» — это то, ради
 * чего панель вообще открывают, и ошибиться в счёте здесь дороже всего.
 */
export interface ProgressSummary {
  total: number;
  done: number;
  /** Чекпоинт, который агент делает прямо сейчас (первый in_progress). */
  current?: string;
  /** Сколько субагентов ещё работает — по ним видно, что дерево живое. */
  agentsRunning: number;
  agentsTotal: number;
  /** Показывать ли панель вообще: пустой план — пустая полоса внизу экрана. */
  hasAnything: boolean;
}

export function summarizeProgress(progress: ChatProgress | undefined): ProgressSummary {
  const tasks = progress?.tasks ?? [];
  const agents = progress?.agents ?? [];

  return {
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'completed').length,
    current: tasks.find((task) => task.status === 'in_progress')?.text,
    agentsRunning: agents.filter((agent) => agent.status === 'running').length,
    agentsTotal: agents.length,
    hasAnything: tasks.length > 0 || agents.length > 0,
  };
}
