import type { ChatProgress } from '@agentdeck/contracts';
import type { ProgressSummary } from './progressView.types';
import { shellView } from './shellView';
import { isLostShell } from './progressView';

export function summarizeProgress(
  progress: ChatProgress | undefined,
  isRunning = false,
): ProgressSummary {
  const tasks = progress?.tasks ?? [];
  const agents = progress?.agents ?? [];
  const shells = (progress?.shells ?? []).map((shell) =>
    shellView(shell, isRunning, progress?.processAlive),
  );
  const activeTool = isRunning ? progress?.activeTool : undefined;

  return {
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'completed').length,
    current: tasks.find((task) => task.status === 'in_progress')?.text,
    agentsRunning: agents.filter((agent) => agent.status === 'running').length,
    agentsTotal: agents.length,
    ...(activeTool ? { activeTool } : {}),
    shellsRunning: shells.filter((status) => status === 'running').length,
    // Остановленное агентом (`killed`) — не обрыв: это его уборка за собой.
    shellsLost: shells.filter(isLostShell).length,
    hasAnything: tasks.length > 0 || agents.length > 0 || shells.length > 0 || Boolean(activeTool),
  };
}
