export interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
  /**
   * Узкий экран: панель принудительно свёрнута в рейку, а кнопку ручного
   * сворачивания прячем — на этой ширине разворачивать панель некуда.
   */
  isNarrow?: boolean;
}
