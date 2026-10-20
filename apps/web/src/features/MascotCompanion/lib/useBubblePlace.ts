import { useEffect, useState, type CSSProperties, type RefObject } from 'react';

/** Зазор между краем боковой панели и облачком, px. */
const GAP = 12;

/** Облачко не прижимается к краям экрана вплотную, px. */
const MARGIN = 12;

/**
 * Место облачка: справа от ВИДИМОГО края боковой панели (в свёрнутой панели
 * кнопка шире рейки — её край не опора), низом по низу маскота — облачко растёт
 * вверх, как реплика героя комикса. Панель сворачивается анимацией ширины, и
 * облачко едет за краем: `ResizeObserver` на самой панели.
 */
export function useBubblePlace(
  anchor: RefObject<HTMLElement | null>,
  active: boolean,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});

  useEffect(() => {
    if (!active) return undefined;
    const nav = anchor.current?.closest('nav') ?? null;
    const place = (): void => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const edge = nav ? Math.min(rect.right, nav.getBoundingClientRect().right) : rect.right;
      setStyle({
        left: Math.max(MARGIN, edge + GAP),
        bottom: Math.max(MARGIN, window.innerHeight - rect.bottom),
      });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    if (nav) observer?.observe(nav);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [active, anchor]);

  return style;
}
