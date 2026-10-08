import { useQueryClient } from '@tanstack/react-query';
import { useManualMutation } from './useManualMutation';
import { api } from '../../shared/api/client';
import type { ProjectTestManualSession } from '@agentdeck/contracts';
import { RUNS_KEY } from './api.constants';

/**
 * Закрыть ручной прогон. `finish` записывает его в историю, `cancel` бросает:
 * разные кнопки, потому что «я закончил» и «я передумал» дают разный след в
 * `runs/` — и путать их значит врать отчёту.
 */
export function useCloseManualRun(projectPath: string | undefined) {
  const client = useQueryClient();
  return useManualMutation(projectPath, async (payload: { runId: string; cancel?: boolean }) => {
    const body = await api.post<{ session?: ProjectTestManualSession }>(
      payload.cancel ? '/project-tests/manual/cancel' : '/project-tests/manual/finish',
      { path: projectPath, runId: payload.runId },
    );
    await client.invalidateQueries({ queryKey: [RUNS_KEY, projectPath] });
    return body;
  });
}
