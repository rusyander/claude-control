import { useQuery } from '@tanstack/react-query';
import type { ProjectGitInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { keyFor } from '../lib/keyFor';

/**
 * Как часто перечитывается состояние репозитория, пока агент работает и пока
 * нет.
 *
 * Пятнадцати секунд достаточно, когда репозиторий меняет человек в терминале, и
 * слишком много, когда его меняет агент в этом же окне: он заводит ветку и
 * коммитит за секунды, а панель до следующего такта показывала бы прежнюю
 * ветку — то есть врала бы ровно в момент, ради которого на неё и смотрят.
 */
const IDLE_INTERVAL_MS = 15_000;
const RUNNING_INTERVAL_MS = 4_000;

/**
 * Состояние репозитория проекта; `isRepo:false` — пульт не показывается.
 * `isRunning` — идёт ли прогон в этом каталоге: от него зависит частота опроса.
 */
export function useProjectGit(path: string | undefined, isRunning = false) {
  return useQuery({
    queryKey: keyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectGitInfo>('/project-git', { params: { path } });
      return data;
    },
    enabled: Boolean(path),
    refetchOnWindowFocus: true,
    refetchInterval: isRunning ? RUNNING_INTERVAL_MS : IDLE_INTERVAL_MS,
  });
}
