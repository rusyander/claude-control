import { useRunnerInfoMutation } from './useRunnerInfoMutation';

/** Снять автозапуск со всех целей проекта — закрытая вкладка ничего не обещает. */
export function useClearRunnerAutostart() {
  return useRunnerInfoMutation<{ path: string }>('/project-runner/autostart/clear', ({ path }) => ({
    path,
  }));
}
