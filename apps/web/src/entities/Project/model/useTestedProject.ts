import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@agentdeck/contracts';
import { useWorkspace } from '@shared/lib/workspace';
import { useProjectRegistry } from '../api/ProjectRegistryApi';

/**
 * Проект, над которым идёт работа в разделе тестирования.
 *
 * Берётся из того же реестра, что и раздел «Проекты»: второго списка проектов в
 * панели нет и не заводится. Выбор запоминается — тестировщик открывает раздел
 * десятки раз в день и всегда для одного и того же проекта, а выбирать его
 * каждый раз заново значит платить за это кликом на каждом открытии.
 *
 * `localStorage`, а не сервер: это предпочтение ЭТОГО браузера, а не настройка
 * проекта, и переносить его на телефон было бы неверно — там открывают другое.
 */
const STORAGE_KEY = 'agentdeck:tests-project';

export interface TestsProject {
  projects: Project[];
  isLoading: boolean;
  selected?: Project;
  select: (id: string) => void;
}

export function readStored(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? '';
  } catch {
    // Приватное окно и запрет на хранилище — не повод падать: просто нет памяти.
    return '';
  }
}

export function writeStored(id: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // См. выше: запись — удобство, а не условие работы раздела.
  }
}

/**
 * Какой проект открывать.
 *
 * Запомненный проект мог исчезнуть из реестра — тогда открывается первый, а не
 * пустой экран: пустота здесь читается как «раздел сломан». Пустой реестр —
 * другое дело: выбор сохраняется, проекты ещё грузятся.
 */
export function resolveSelected(projects: Project[], selectedId: string): string {
  if (projects.length === 0) return selectedId;
  const exists = projects.some((project) => project.id === selectedId);
  return exists ? selectedId : (projects[0]?.id ?? '');
}

/**
 * Реестр плюс открытые вкладки проектов.
 *
 * Реестр — канонический список, но человек может работать во вкладке проекта,
 * ни разу его туда не добавив: тогда панель проект ЗНАЕТ, а раздел тестов
 * показывал бы «проектов нет» — тупик на ровном месте. Вкладки дописываются
 * после реестра и только те, которых в нём ещё нет.
 */
export function mergeProjects(registry: Project[], tabs: Project[]): Project[] {
  const known = new Set(registry.map((project) => project.path.toLowerCase()));
  return [...registry, ...tabs.filter((tab) => !known.has(tab.path.toLowerCase()))];
}

export function useTestsProject(): TestsProject {
  const { data: registry = [], isLoading } = useProjectRegistry();
  const { state } = useWorkspace();
  const projects = useMemo(
    () => mergeProjects(registry, state.projectTabs),
    [registry, state.projectTabs],
  );
  const [selectedId, setSelectedId] = useState<string>(() => readStored());

  useEffect(() => {
    const next = resolveSelected(projects, selectedId);
    if (next !== selectedId) setSelectedId(next);
  }, [projects, selectedId]);

  return {
    projects,
    isLoading,
    selected: projects.find((project) => project.id === selectedId),
    select: (id) => {
      setSelectedId(id);
      writeStored(id);
    },
  };
}
