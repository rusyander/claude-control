import { useMemo } from 'react';
import type { AgentRun } from '@shared/lib/agent-runs';
import type { StreamState } from '@entities/Chat';

/**
 * Прогон активного чата в том виде, в каком его читает лента сообщений: текст,
 * размышления, инструменты и статус. Фоновые прогоны других чатов живут в том
 * же сторе и продолжаются независимо.
 */
export function useStreamState(run: AgentRun, isRunning: boolean): StreamState {
  return useMemo(
    () => ({
      text: run.text,
      textUsage: run.textUsage,
      thinking: run.thinking,
      tools: run.tools,
      isRunning,
      error: run.error,
      sessionId: run.sessionId,
      costUsd: run.costUsd,
      limitResetsAt: run.limitResetsAt,
    }),
    [run, isRunning],
  );
}
