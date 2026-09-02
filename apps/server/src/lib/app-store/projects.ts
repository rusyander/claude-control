import type { Project } from '@claude-control/contracts';
import type { AppState } from './app-store.types.ts';

/** Нормализация пути для сравнения: Windows нечувствителен к регистру и слэшам. */
export function normalizeProjectPath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

export function listProjects(state: AppState): Project[] {
  return [...state.projects];
}

export function findProject(state: AppState, id: string): Project | undefined {
  return state.projects.find((project) => project.id === id);
}

/** Запись реестра по каталогу — регистр и слэши не различаются, как у `addProject`. */
export function findProjectByPath(state: AppState, path: string): Project | undefined {
  const wanted = normalizeProjectPath(path);
  return state.projects.find((item) => normalizeProjectPath(item.path) === wanted);
}

/**
 * Добавить проект в реестр. Один и тот же каталог не заводим дважды: если он
 * уже запомнен, возвращаем существующую запись как есть, а не плодим дубликаты
 * с разными id. Имя при этом НЕ переписывается: «создать» не должно молча
 * переименовывать — маршрут отвечает на повтор 409, а этот путь остаётся для
 * вызовов внутри сервера (активация групп по пути).
 */
export function addProject(state: AppState, project: Project): Project {
  const existing = findProjectByPath(state, project.path);
  if (existing) return existing;

  state.projects.push(project);
  return project;
}

/** Убрать проект из реестра. Файлы проекта при этом не трогаем — только путь. */
export function removeProject(state: AppState, id: string): void {
  state.projects = state.projects.filter((project) => project.id !== id);
}
