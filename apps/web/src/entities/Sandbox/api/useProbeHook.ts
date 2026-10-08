import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/** `error` — прогон не состоялся: хук не запустился или упал, решения нет. */
export type HookDecision = 'block' | 'ask' | 'pass' | 'error';

export interface ProbeResult {
  fixtureId: string;
  exitCode: number;
  /** Сигнал, которым хук убит извне (тогда `exitCode` = -1, причина это называет). */
  signal?: string;
  stdout: string;
  stderr: string;
  decision: HookDecision;
  reason?: string;
  addedContext?: string;
  matchesExpectation: boolean;
  durationMs: number;
  timedOut: boolean;
}

export function useProbeHook() {
  return useMutation({
    mutationFn: async (input: {
      id: string;
      hookId?: string;
      scriptName?: string;
      fixtureIds?: string[];
      /** Свой ввод: сырой JSON события вместо заготовок. */
      customEvent?: string;
    }) => {
      const { data } = await apiClient.post<{
        results: ProbeResult[];
        command?: string;
        error?: string;
      }>('/sandbox/probe-hook', input, { timeout: 180_000 });
      return data;
    },
  });
}
