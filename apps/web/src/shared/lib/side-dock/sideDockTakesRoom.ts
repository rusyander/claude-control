import { isBesideDock } from './side-dock';

/** Переменная, на которую пристёгнутое окно сдвигает страницу; 0 — поверх страницы. */
export const SIDE_DOCK_INSET_VAR = '--panel-agent-dock-inset';

/** Открыто ли пристёгнутое окно так, что модальному окну есть место слева. */
export function sideDockTakesRoom(): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return isBesideDock(getComputedStyle(root).getPropertyValue(SIDE_DOCK_INSET_VAR));
}
