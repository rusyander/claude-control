import { useRunnerInfoMutation } from './useRunnerInfoMutation';
import type { RunnerTargetRef } from './ProjectRunnerApi.types';

/**
 * Отметка цели «входит в «Запустить всё»». Набор запоминается на проект:
 * отметили api и worker один раз — дальше они поднимаются одной кнопкой.
 */
export function useSetRunnerGroup() {
  return useRunnerInfoMutation<RunnerTargetRef & { inGroup: boolean }>(
    '/project-runner/group',
    ({ path, dir, inGroup }) => ({ path, dir, inGroup }),
    true,
  );
}
