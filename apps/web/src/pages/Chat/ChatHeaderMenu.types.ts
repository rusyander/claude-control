export interface ChatHeaderMenuProps {
  /** Тумблер правок показывается только в разговоре о настоящем проекте. */
  allowEdits?: boolean;
  onAllowEditsChange?: (value: boolean) => void;

  /**
   * Каталог проекта: правило подбора модели помнится на проект, и без пути
   * тумблеру не к чему относиться — в разговоре вне проекта он не показывается.
   */
  projectPath?: string;

  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;

  /** Разговор сохранён, его можно выгрузить файлом. */
  canExport: boolean;
  onExport: () => void;
  onRefresh: () => void;

  /**
   * Перезапуск сессии: новый разговор того же проекта по файлу-опоре, дорогой
   * контекст остаётся позади. Пусто — разговора или проекта ещё нет.
   */
  onRestartSession?: () => void;
  /** Почему перезапуск сейчас недоступен (идёт прогон) — кнопка погашена с подсказкой. */
  restartBlocked?: string;
}
