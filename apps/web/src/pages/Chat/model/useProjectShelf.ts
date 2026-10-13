import { useMemo } from 'react';
import type { Project } from '@agentdeck/contracts';
import { useAddProject, useProjectRegistry, type ProjectInfo } from '@entities/Project';
import { useWorkspace } from '@shared/lib/workspace';

export interface ProjectShelf {
  registry: Project[];
  register: (project: { path: string; name: string }) => void;
  /** Путь, который добавляется прямо сейчас. */
  registeringPath: string | undefined;
  openIds: ReadonlySet<string>;
  openMany: (projects: ProjectInfo[]) => void;
}

/**
 * Чат и страница «Проекты» — одна полка проектов: что на ней есть, добавить
 * туда проект из чата и открыть несколько с неё вкладками разом. Состояние
 * вкладок и реестра живёт там же, где и раньше, — здесь только сведение.
 */
export function useProjectShelf(): ProjectShelf {
  const ws = useWorkspace();
  const { data: registry = [] } = useProjectRegistry();
  const add = useAddProject();

  const openIds = useMemo(
    () => new Set(ws.state.projectTabs.map((tab) => tab.id)),
    [ws.state.projectTabs],
  );

  return {
    registry,
    register: (project) => add.mutate({ path: project.path, name: project.name }),
    registeringPath: add.isPending ? add.variables?.path : undefined,
    openIds,
    // По очереди: последняя открытая вкладка становится активной.
    openMany: (projects) => {
      for (const project of projects) ws.openProject(project.path, project.name);
    },
  };
}
