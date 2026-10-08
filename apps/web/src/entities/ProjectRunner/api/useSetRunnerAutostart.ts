import { useRunnerInfoMutation } from './useRunnerInfoMutation';
import type { RunnerTargetRef } from './ProjectRunnerApi.types';

/**
 * Тумблер автозапуска цели: поднимать ли её dev-сервер при старте сервера
 * панели. Ничего не запускает здесь и сейчас — это про следующий старт.
 */
export function useSetRunnerAutostart() {
  return useRunnerInfoMutation<RunnerTargetRef & { enabled: boolean }>(
    '/project-runner/autostart',
    ({ path, dir, enabled }) => ({ path, dir, enabled }),
    true,
  );
}
