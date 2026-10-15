import type { ProgressAgent } from '@agentdeck/contracts';
import type { AgentView } from './progressView.types';

/**
 * Что стало с субагентом — с поправкой на процесс, как у фоновой команды. Фоновый
 * субагент живёт, пока жив процесс CLI разговора; умер процесс — итога не будет,
 * а транскрипт по-прежнему зовёт его «работает» (живой прогон 14.10). Сервер без
 * признака процесса (старый) — как было.
 */
export function agentView(
  agent: ProgressAgent,
  isRunning: boolean,
  processAlive: boolean | undefined = undefined,
): AgentView {
  if (agent.status === 'running' && !isRunning && processAlive === false) return 'lost';
  return agent.status;
}

/** Фоновый субагент между ходами: идёт, пока жив процесс, — его и опрашиваем. */
export function backgroundAgentRunning(
  agents: readonly ProgressAgent[],
  processAlive: boolean | undefined,
): boolean {
  return processAlive === true && agents.some((agent) => agent.status === 'running');
}
