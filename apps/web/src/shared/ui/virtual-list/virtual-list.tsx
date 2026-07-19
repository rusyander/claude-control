import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import styles from './virtual-list.module.scss';
import type { VirtualListProps } from './virtual-list.types';

/**
 * Список с виртуализацией: в DOM живут только видимые строки. Включается
 * по порогу, а не всегда — виртуализация ломает поиск по странице (Ctrl+F)
 * и выделение текста, поэтому на коротких списках она вредна.
 */
export function VirtualList<TItem>({
  items,
  rowHeight,
  height,
  renderRow,
  getKey,
  threshold = 40,
}: VirtualListProps<TItem>) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const sizeOf = (index: number): number => {
    const item = items[index];
    if (typeof rowHeight !== 'function') return rowHeight;
    return item === undefined ? 0 : rowHeight(item, index);
  };

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: sizeOf,
    // Небольшой запас сверху и снизу: строки успевают отрисоваться
    // до того, как попадут в кадр при быстрой прокрутке.
    overscan: 8,
  });

  if (items.length < threshold) {
    return (
      <div className={styles.plain}>
        {items.map((item, index) => (
          <div key={getKey(item, index)}>{renderRow(item, index)}</div>
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className={styles.viewport} style={{ height }}>
      <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;

          return (
            <div
              key={getKey(item, virtualRow.index)}
              className={styles.row}
              style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderRow(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
