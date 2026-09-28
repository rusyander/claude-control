import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

/** Отступ поповера от края окна: вплотную к краю он читается обрезанным. */
export const PANEL_VIEWPORT_MARGIN = 8;

/** Зазор между кнопкой и поповером — тот же, что в стилях панелей шапки. */
const PANEL_GAP = 4;

/** Меньше этого поповер не сжимается: прокрутка в щели хуже выхода за окно. */
const PANEL_MIN_BLOCK = 160;

/** Сдвиг, ширина и высота поповера под текущее окно. */
interface AnchoredPlacement {
  left: number;
  maxInline: number;
  maxBlock: number;
}

/** Видимая область: окно ∩ предки, которые режут вылет (`overflow` ≠ visible). */
function visibleArea(from: HTMLElement): { left: number; right: number; bottom: number } {
  let left = 0;
  let right = document.documentElement.clientWidth;
  let bottom = window.innerHeight;
  for (let node = from.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const box = node.getBoundingClientRect();
    if (style.overflowX !== 'visible') {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (style.overflowY !== 'visible') bottom = Math.min(bottom, box.bottom);
  }
  return { left, right, bottom };
}

/**
 * Держит выпадающую панель кнопки целиком в окне.
 *
 * Панели шапки привязаны к правому краю своей кнопки (`right: 0`). Пока ряд
 * помещается в строку, этого хватает; но на узком окне ряд переносится, кнопка
 * уезжает к левому краю — и панель шириной 360–420px вылезала за левую кромку
 * окна (на 400px — на 16px, первая строка терялась). Здесь панель после
 * открытия меряется и сдвигается по горизонтали ровно настолько, чтобы влезть
 * в видимую область — окно, урезанное предками с `overflow` (оболочка чата
 * режет всё, что левее её, и там панель пропадала бы уже не за краем окна, а
 * под навигацией); не влезает по ширине — ужимается до неё,
 * а её высота ограничивается местом до низа окна (CSS-переменная
 * `--panel-max-block`, её читает `max-height` панели; своё CSS-ограничение
 * панели остаётся в силе).
 *
 * Панель обязана быть `position: absolute` внутри `position: relative` обёртки
 * кнопки — от обёртки и считается сдвиг.
 */
export function useAnchoredPanel<TElement extends HTMLElement>(isOpen: boolean) {
  const panelRef = useRef<TElement>(null);
  const [placement, setPlacement] = useState<AnchoredPlacement | undefined>();

  const measure = useCallback((): void => {
    const panel = panelRef.current;
    const anchor = panel?.offsetParent;
    if (!panel || !(anchor instanceof HTMLElement)) return;
    const box = anchor.getBoundingClientRect();
    const span = visibleArea(anchor);
    const maxInline = Math.floor(span.right - span.left - 2 * PANEL_VIEWPORT_MARGIN);
    // Ширину меряем уже с новым потолком: иначе сдвиг считался бы по старой.
    panel.style.maxWidth = `${maxInline}px`;
    const width = panel.offsetWidth;
    // По умолчанию — к правому краю кнопки, как было; дальше только поправка.
    const wanted = box.right - width;
    const most = span.right - PANEL_VIEWPORT_MARGIN - width;
    const clamped = Math.max(span.left + PANEL_VIEWPORT_MARGIN, Math.min(wanted, most));
    const below = span.bottom - box.bottom - PANEL_GAP - PANEL_VIEWPORT_MARGIN;
    const next = {
      left: Math.round(clamped - box.left),
      maxInline,
      maxBlock: Math.max(PANEL_MIN_BLOCK, Math.floor(below)),
    };
    setPlacement((prev) =>
      prev &&
      prev.left === next.left &&
      prev.maxInline === next.maxInline &&
      prev.maxBlock === next.maxBlock
        ? prev
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement(undefined);
      return;
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isOpen, measure]);

  const panelStyle: CSSProperties | undefined = placement
    ? ({
        left: placement.left,
        right: 'auto',
        maxWidth: placement.maxInline,
        '--panel-max-block': `${placement.maxBlock}px`,
      } as CSSProperties)
    : undefined;

  return { panelRef, panelStyle };
}
