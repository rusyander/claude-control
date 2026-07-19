/** Постоянный таб домашнего чата — он всегда есть и не закрывается. */
export const HOME_TAB_ID = 'home';

/** Открытый таб проекта в шапке чата. */
export interface ProjectTab {
  /** Нормализованный путь — стабильный id таба (для дедупликации и адреса). */
  id: string;
  /** Абсолютный путь каталога проекта. */
  path: string;
  /** Короткое имя для подписи таба. */
  name: string;
}

export interface WorkspaceState {
  /** Открытые табы проектов (домашний таб подразумевается первым, вне списка). */
  projectTabs: ProjectTab[];
  /** Активный таб: `home` или id проекта-таба. */
  activeTabId: string;
}
