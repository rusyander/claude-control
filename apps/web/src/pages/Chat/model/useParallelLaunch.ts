import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@shared/lib/workspace';
import { agentRuns } from '@shared/lib/agent-runs';
import { chatKeys } from '@entities/Chat';
import type { ProjectInfo } from '@entities/Project';

export interface ParallelLaunchInput {
  /** Модель и глубина продумывания, с которыми уйдут все прогоны разом. */
  model: string;
  effort: string;
}

export interface ParallelLaunchApi {
  isParallelOpen: boolean;
  setParallelOpen: (open: boolean) => void;
  launchParallel: (selected: ProjectInfo[], prompt: string, editsAllowed: boolean) => void;
}

/**
 * Один запрос в нескольких проектах разом: в каждом открываем таб и стартуем
 * свой прогон. Они идут в фоне, а следить за ними — по точкам и в пульте.
 */
export function useParallelLaunch({ model, effort }: ParallelLaunchInput): ParallelLaunchApi {
  const queryClient = useQueryClient();
  const ws = useWorkspace();
  const [isParallelOpen, setParallelOpen] = useState(false);

  const launchParallel = (selected: ProjectInfo[], prompt: string, editsAllowed: boolean): void => {
    const stamp = Date.now();
    selected.forEach((project, index) => {
      ws.openProject(project.path, project.name);
      void agentRuns.start({
        chatId: `new-${stamp}-${index}`,
        prompt,
        projectPath: project.path,
        allowEdits: editsAllowed,
        model,
        effort,
      });
    });
    setParallelOpen(false);
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
  };

  return { isParallelOpen, setParallelOpen, launchParallel };
}
