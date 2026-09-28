import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@agentdeck/contracts';
import { normalizeProjectPath, useWorkspace } from '@shared/lib/workspace';
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
  /** Реестр не загрузился: список тогда — только открытые вкладки, и «проектов нет» было бы неправдой. */
  isError: boolean;
  /** Перечитать реестр — для кнопки «Повторить» у ошибки. */
  retry: () => void;
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

/**
 * Кто держит выбор у себя: страница тестов, окно агента панели. Выбор на одной
 * копии хука будит остальные — иначе окно агента подписывало проект A, а
 * агент получал B, выбранный на странице (память читается в момент отправки).
 */
const listeners = new Set<(id: string) => void>();

export function subscribeStored(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function writeStored(id: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // См. выше: запись — удобство, а не условие работы раздела.
  }
  // Id — аргументом, а не из хранилища: в приватном окне хранилище молчит.
  for (const listener of listeners) listener(id);
}

/**
 * Какой проект открывать.
 *
 * Запомненный проект мог исчезнуть из реестра — тогда открывается первый, а не
 * пустой экран: пустота здесь читается как «раздел сломан». Пока реестр грузится,
 * выбор сохраняется: список тогда — одни открытые вкладки, и запомненный проект
 * из реестра в нём «исчез» бы, уступив место первой вкладке. Так же — пока реестр
 * не загрузился с ошибкой: иначе запомненный проект подменялся первой вкладкой
 * до конца сессии, и «Повторить» его уже не возвращал (ревью 28.09, F-194).
 */
export function resolveSelected(
  projects: Project[],
  selectedId: string,
  isLoading = false,
  isError = false,
): string {
  if (isLoading || isError || projects.length === 0) return selectedId;
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

/**
 * Проект по каталогу: так его называет агент панели (`/tests?project=<путь>`).
 * Один каталог пишется по-разному — регистр и слэши не различаем.
 */
export function projectByPath(projects: Project[], path: string): Project | undefined {
  const wanted = normalizeProjectPath(path);
  return projects.find((project) => normalizeProjectPath(project.path) === wanted);
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
