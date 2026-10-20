import { useEffect, type RefObject } from 'react';

/** Дальше этого расстояния взгляд упирается в край глаза, px. */
const REACH_PX = 240;

/** Мельче этого сдвиг не пишем: глаз 4 px, разницу не видно. */
const STEP = 0.08;

/**
 * Зрачок смотрит на курсор, из центра маскота. Пишет `--look-x` / `--look-y`
 * прямо в `target` — мимо React: движение мыши не перерисовывает компонент,
 * зрачок доезжает CSS-переходом. Считается не чаще кадра и только пока `active`
 * (в покое): в остальных настроениях взгляд — часть мимики, а при «Меньше
 * движения» глаз за мышью не бегает вовсе.
 */
export function useCursorLook(target: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!element || !active) return undefined;
    let frame = 0;
    let pointer: { x: number; y: number } | undefined;
    let look = { x: 0, y: 0 };

    const update = (): void => {
      frame = 0;
      if (!pointer) return;
      const rect = element.getBoundingClientRect();
      const dx = pointer.x - (rect.left + rect.width / 2);
      const dy = pointer.y - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, distance / REACH_PX);
      const next = { x: (dx / distance) * reach, y: (dy / distance) * reach };
      if (Math.abs(look.x - next.x) < STEP && Math.abs(look.y - next.y) < STEP) return;
      look = next;
      element.style.setProperty('--look-x', next.x.toFixed(2));
      element.style.setProperty('--look-y', next.y.toFixed(2));
    };

    const onMove = (event: PointerEvent): void => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) window.cancelAnimationFrame(frame);
      element.style.removeProperty('--look-x');
      element.style.removeProperty('--look-y');
    };
  }, [active, target]);
}
