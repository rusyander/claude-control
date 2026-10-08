import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@agentdeck/contracts';
import { useWorkspace } from '@shared/lib/workspace';
import { useProjectRegistry } from '../api/ProjectRegistryApi';
import { resolveSelected } from '../lib/resolveSelected';
import { mergeProjects } from '../lib/mergeProjects';
import { readStored } from '../lib/readStored';
import { subscribeStored } from '../lib/subscribeStored';
import { writeStored } from '../lib/writeStored';

export interface TestsProject {
  projects: Project[];
  isLoading: boolean;
  /** Реестр не загрузился: список тогда — только открытые вкладки, и «проектов нет» было бы неправдой. */
  isError: boolean;
  /** Перечитать реестр — для кнопки «Повторить» у ошибки. */
  retry: () => void;
  selected?: Project;
  select: (id: string) => void;
}

export function useTestsProject(): TestsProject {
  const { data: registry = [], isLoading, isError, refetch } = useProjectRegistry();
  const { state } = useWorkspace();
  const projects = useMemo(
    () => mergeProjects(registry, state.projectTabs),
    [registry, state.projectTabs],
  );
  const [selectedId, setSelectedId] = useState<string>(() => readStored());
  // Выбор, сделанный другой копией хука, — и здесь: память в хранилище одна.
  useEffect(() => subscribeStored(setSelectedId), []);

  useEffect(() => {
    const next = resolveSelected(projects, selectedId, isLoading, isError);
    if (next !== selectedId) setSelectedId(next);
  }, [projects, selectedId, isLoading, isError]);
  // Реестр упал: выбор в памяти прежний, а показывается первое из того, что есть,
  // — работать по вкладкам можно, пустой раздел читался бы как поломка.
  const shownId = isError ? resolveSelected(projects, selectedId) : selectedId;

  return {
    projects,
    isLoading,
    isError,
    retry: () => void refetch(),
    selected: projects.find((project) => project.id === shownId),
    select: (id) => {
      setSelectedId(id);
      writeStored(id);
    },
  };
}
