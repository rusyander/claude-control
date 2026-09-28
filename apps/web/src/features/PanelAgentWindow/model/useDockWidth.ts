import { useCallback, useEffect, useState } from 'react';
import {
  DOCK_WIDE_FROM,
  DOCK_WIDTH_MIN,
  clampDockWidth,
  dockWidthMax,
  localStore,
  readDockWidth,
  writeDockWidth,
} from './dockWidth';

/** Переменная ширины окна — её же читает отступ страницы (`PanelAgent.module.scss`). */
const WIDTH_VAR = '--panel-agent-dock-width';

const viewportWidth = (): number => (typeof window === 'undefined' ? 1280 : window.innerWidth);

/**
 * Ширина окна агента на широком экране. Помнится желаемая ширина, а на экран
 * ложится зажатая в его границы: окно браузера сузили и расширили обратно —
 * окно агента вернулось к своей ширине, а не осталось узким навсегда.
 */
export function useDockWidth() {
  const [preferred, setPreferred] = useState(() => readDockWidth(localStore()));
  const [viewport, setViewport] = useState(viewportWidth);

  useEffect(() => {
    const onResize = (): void => setViewport(viewportWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isWide = viewport >= DOCK_WIDE_FROM;
  const width = clampDockWidth(preferred, viewport);
  const max = dockWidthMax(viewport);

  // Ширина — переменной на корне: одна для самого окна и для отступа страницы,
  // иначе они разошлись бы при первом же перетаскивании. На узком экране — снята:
  // там окно поверх страницы, и ширина из стилей (во весь экран) правильная.
  useEffect(() => {
    const root = document.documentElement;
    if (isWide) root.style.setProperty(WIDTH_VAR, `${width}px`);
    else root.style.removeProperty(WIDTH_VAR);
    return () => {
      root.style.removeProperty(WIDTH_VAR);
    };
  }, [isWide, width]);

  const resize = useCallback(
    (next: number): void => {
      // Ручка сама зажимает ширину при смене границ и сообщает её — это не
      // выбор человека, и узкое окно браузера не должно перезаписать привычку.
      // Значение уже в границах [min, max]: их ручке отдаёт этот же хук.
      if (next === width) return;
      setPreferred(next);
      writeDockWidth(localStore(), next);
    },
    [width],
  );

  return { width, min: DOCK_WIDTH_MIN, max, isWide, resize };
}
