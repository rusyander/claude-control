import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { scrollDecision } from './virtual-list.lib';
import styles from './virtual-list.module.scss';
import type { VirtualListProps } from './virtual-list.types';
import { scrollParentOf } from './lib/scrollParentOf';

/**
 * Список с виртуализацией: в DOM живут только видимые строки. Включается
 * по порогу, а не всегда — виртуализация ломает поиск по странице (Ctrl+F)
 * и выделение текста, поэтому на коротких списках она вредна.
 *
 * Два режима. С `height` — своё окно прокрутки заданной высоты (колонка чата).
 * Без него — список прокручивается вместе со страницей: окно считается от
 * прокрутки раздела, а отступ списка от её начала (`scrollMargin`) пересчитывается,
 * когда меняется что-то выше списка (перенос фильтров, появившаяся плашка).
 */
export function VirtualList<TItem>({
  items,
  rowHeight,
  height,
  renderRow,
  getKey,
  threshold = 40,
  scrollToKey,
  scrollNonce,
}: VirtualListProps<TItem>) {
  const ownScroll = height !== undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledKey = useRef<string | undefined>(undefined);
  // Когда пришла просьба прокрутить: ждёт строку не дольше срока (virtual-list.lib).
  // Эффект стоит выше эффекта прокрутки: в одном коммите он успевает раньше.
  const request = useRef<{ key: string; at: number } | undefined>(undefined);
  useEffect(() => {
    if (!scrollToKey) return;
    request.current = { key: scrollToKey, at: Date.now() };
    // Новая просьба — даже с тем же ключом: «уже докручено» относится к прошлой.
    scrolledKey.current = undefined;
  }, [scrollToKey, scrollNonce]);
  const [pageScroller, setPageScroller] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const sizeOf = (index: number): number => {
    const item = items[index];
    if (typeof rowHeight !== 'function') return rowHeight;
    return item === undefined ? 0 : rowHeight(item, index);
  };

  const isVirtual = items.length >= threshold;

  // Режим страницы: найти прокрутку раздела и держать отступ списка от её начала.
  // Следим за всеми предками до неё: любой блок выше списка, сменивший высоту,
  // меняет высоту и общего предка.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (ownScroll || !isVirtual || !list) return;
    const scroller = scrollParentOf(list);
    setPageScroller(scroller);
    if (!scroller) return;
    const measure = (): void => {
      const margin =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setScrollMargin((current) => (Math.abs(current - margin) > 0.5 ? margin : current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (let node = list.parentElement; node && node !== scroller; node = node.parentElement) {
      observer.observe(node);
    }
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ownScroll, isVirtual]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => (ownScroll ? scrollRef.current : pageScroller),
    estimateSize: sizeOf,
    scrollMargin: ownScroll ? 0 : scrollMargin,
    // Небольшой запас сверху и снизу: строки успевают отрисоваться
    // до того, как попадут в кадр при быстрой прокрутке.
    overscan: 8,
  });

  useEffect(() => {
    if (!isVirtual || !scrollToKey || scrolledKey.current === scrollToKey) return;
    if (!ownScroll && !pageScroller) return;
    const index = items.findIndex((item, at) => getKey(item, at) === scrollToKey);
    const decision = scrollDecision({
      index,
      requestedAt: request.current?.at ?? Date.now(),
      now: Date.now(),
    });
    if (decision === 'wait') return;
    scrolledKey.current = scrollToKey;
    if (decision === 'scroll') virtualizer.scrollToIndex(index, { align: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToKey, scrollNonce, items, isVirtual, pageScroller]);

  if (!isVirtual) {
    return (
      <div className={styles.plain}>
        {items.map((item, index) => (
          <div key={getKey(item, index)}>{renderRow(item, index)}</div>
        ))}
      </div>
    );
  }

  const offset = ownScroll ? 0 : scrollMargin;
  const canvas = (
    <div
      ref={ownScroll ? undefined : listRef}
      className={styles.canvas}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) return null;

        return (
          // `data-index` — номер строки в списке, а не место в DOM: строки
          // переиспользуют узлы при прокрутке, и обход клавиатуры, узнающий
          // остановку по пути в DOM, иначе принимал новую строку за уже
          // пройденную и объявлял круг замкнутым посреди списка.
          <div
            key={getKey(item, virtualRow.index)}
            data-index={virtualRow.index}
            className={styles.row}
            style={{
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start - offset}px)`,
            }}
          >
            {renderRow(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );

  if (!ownScroll) return canvas;

  return (
    <div ref={scrollRef} className={styles.viewport} style={{ height }}>
      {canvas}
    </div>
  );
}
