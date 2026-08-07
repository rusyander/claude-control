import { useCallback, useEffect, useRef } from 'react';
import type { ResizeHandleProps } from './resize-handle.types';
import styles from './resize-handle.module.scss';

/**
 * Вертикальный разделитель, за который панель тянут мышью.
 *
 * Во время перетаскивания слушатели висят на документе, а не на самой полоске:
 * курсор легко убегает за её пределы, и без этого панель бросало бы при первом
 * же резком движении. Клавиатура тоже работает — стрелками, шагом по 24px.
 */
export function ResizeHandle({
  width,
  onResize,
  min = 320,
  max = 900,
  label,
  side = 'right',
}: ResizeHandleProps) {
  const startRef = useRef({ x: 0, width: 0 });
  // Панель справа расширяется движением влево, панель слева — вправо.
  const direction = side === 'left' ? 1 : -1;

  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    startRef.current = { x: event.clientX, width };

    const onMove = (moveEvent: PointerEvent): void => {
      onResize(
        clamp(startRef.current.width + direction * (moveEvent.clientX - startRef.current.x)),
      );
    };

    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    // Пока тянем, выделение текста и «мигающий» курсор только мешают.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // Текущая ширина и колбэк родителя меняются на каждом движении мыши: попади
  // они в зависимости — эффект гонялся бы за собственным результатом.
  const latest = useRef({ width, onResize, clamp });
  latest.current = { width, onResize, clamp };

  useEffect(() => {
    const { width: current, onResize: emit, clamp: fit } = latest.current;
    emit(fit(current));
    // Пересчитываем только при смене границ: например, когда окно уменьшилось.
  }, [min, max]);

  return (
    <div
      className={styles.handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') onResize(clamp(width - direction * 24));
        if (event.key === 'ArrowRight') onResize(clamp(width + direction * 24));
      }}
    >
      <span className={styles.grip} />
    </div>
  );
}
