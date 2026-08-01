import { HOME_TAB_ID, type ProjectTab, type WorkspaceState } from './workspace.types';

/**
 * Состояние рабочего пространства чата: какие проекты открыты табами и какой
 * таб активен. Это клиентское состояние интерфейса (не серверные данные),
 * поэтому живёт в singleton-сторе и переживает перезагрузку через localStorage.
 *
 * Вся логика переходов вынесена в чистые функции ниже — их и покрываем тестами,
 * а сам стор лишь хранит текущее состояние и уведомляет подписчиков. Так
 * поведение табов проверяется без React и без хранилища.
 */

const STORAGE_KEY = 'claude-control:workspace';

const EMPTY: WorkspaceState = { projectTabs: [], activeTabId: HOME_TAB_ID };

/** Один каталог пишется по-разному (регистр, слэши) — приводим к общему виду. */
export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Короткое имя проекта из пути — для табов и уведомлений о фоновом агенте. */
export function projectShortName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Открыть проект: если таб уже есть — просто активировать, иначе добавить. */
export function openProjectTab(
  state: WorkspaceState,
  project: { path: string; name: string },
): WorkspaceState {
  const id = normalizeProjectPath(project.path);
  const exists = state.projectTabs.some((tab) => tab.id === id);
  const projectTabs = exists
    ? state.projectTabs
    : [...state.projectTabs, { id, path: project.path, name: project.name }];
  return { projectTabs, activeTabId: id };
}

/**
 * Закрыть таб проекта. Если закрывали активный — фокус уходит на левого соседа
 * (как во вкладках браузера); у первого проекта левый сосед — домашний таб.
 */
export function closeProjectTab(state: WorkspaceState, id: string): WorkspaceState {
  const index = state.projectTabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;

  const projectTabs = state.projectTabs.filter((tab) => tab.id !== id);
  let activeTabId = state.activeTabId;
  if (activeTabId === id) {
    const leftNeighbor = index > 0 ? state.projectTabs[index - 1]?.id : undefined;
    activeTabId = leftNeighbor ?? HOME_TAB_ID;
  }
  return { projectTabs, activeTabId };
}

/** Сделать таб активным. Несуществующий id игнорируем — состояние не портим. */
export function activateTab(state: WorkspaceState, id: string): WorkspaceState {
  if (id === HOME_TAB_ID || state.projectTabs.some((tab) => tab.id === id)) {
    return { ...state, activeTabId: id };
  }
  return state;
}

/**
 * Привести к валидному виду то, что пришло из хранилища: убрать дубли и битые
 * записи, а активный таб — только существующий (иначе домашний).
 */
export function sanitizeState(raw: unknown): WorkspaceState {
  const source = (raw ?? {}) as Partial<WorkspaceState>;
  const seen = new Set<string>();
  const projectTabs: ProjectTab[] = [];

  for (const tab of Array.isArray(source.projectTabs) ? source.projectTabs : []) {
    if (!tab || typeof tab.id !== 'string' || typeof tab.path !== 'string') continue;
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    projectTabs.push({
      id: tab.id,
      path: tab.path,
      name: typeof tab.name === 'string' && tab.name ? tab.name : tab.path,
    });
  }

  const activeTabId =
    source.activeTabId === HOME_TAB_ID || projectTabs.some((tab) => tab.id === source.activeTabId)
      ? source.activeTabId
      : HOME_TAB_ID;

  return { projectTabs, activeTabId: activeTabId ?? HOME_TAB_ID };
}

// --- Singleton-стор поверх чистых функций ---

function load(): WorkspaceState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? sanitizeState(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function persist(state: WorkspaceState): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Приватный режим или переполнение — работаем в памяти, это не критично.
  }
}

let state: WorkspaceState = load();
const listeners = new Set<() => void>();

function commit(next: WorkspaceState): void {
  if (next === state) return;
  state = next;
  persist(state);
  for (const listener of listeners) listener();
}

export function getWorkspaceState(): WorkspaceState {
  return state;
}

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Императивный API рабочего пространства. */
export const workspace = {
  /** Открыть проект табом и активировать его. Возвращает id таба. */
  openProject(path: string, name: string): string {
    commit(openProjectTab(state, { path, name }));
    return normalizeProjectPath(path);
  },
  closeProject(id: string): void {
    commit(closeProjectTab(state, id));
  },
  activate(id: string): void {
    commit(activateTab(state, id));
  },
};
