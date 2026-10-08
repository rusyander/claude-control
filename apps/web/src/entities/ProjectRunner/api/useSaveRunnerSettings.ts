import { useRunnerInfoMutation } from './useRunnerInfoMutation';
import type { RunnerTargetRef } from './ProjectRunnerApi.types';

/**
 * Команда запуска и закреплённый порт цели. Пустая строка очищает команду,
 * `null` снимает закрепление порта — иначе снять их было бы нечем.
 */
export function useSaveRunnerSettings() {
  return useRunnerInfoMutation<RunnerTargetRef & { command?: string; port?: number | null }>(
    '/project-runner/settings',
    ({ path, dir, command, port }) => ({ path, dir, command, port }),
    true,
  );
}
