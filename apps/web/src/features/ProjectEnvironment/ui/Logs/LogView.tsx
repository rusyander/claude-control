import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { LogLineRow } from './LogLineRow';
import type { LogViewProps } from './Logs.types';
import styles from './Logs.module.scss';

/** «Внизу» с запасом: дробные пиксели и строка, дорисованная после прокрутки. */
const BOTTOM_SLACK_PX = 32;
/** Прокрутка в течение этого времени после колеса, клавиши или нажатия — дело рук человека. */
const USER_SCROLL_MS = 800;
const SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End']);

/**
 * Строки лога с виртуализацией: в DOM только видимые, высота у каждой своя
 * (длинные переносятся, раскрытая — с полями). Слежение: пока включено, вид
 * держится у последней строки. Отключает его только человек — прокруткой
 * вверх; сам вид тоже прокручивается (дописанные строки, обрезка буфера), и
 * его прокрутку за уход читать нельзя. Вернулся вниз — слежение снова
 * включено, без поиска переключателя.
 */
export function LogView({
  label,
  rows,
  search,
  showService,
  follow,
  onFollowChange,
  selectedId,
  onSelect,
  onAsk,
}: LogViewProps) {
  const { t, i18n } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const userAt = useRef(0);
  // Последняя строка, которую человек видел, когда слежение ещё было включено.
  const seenId = useRef<number | undefined>(undefined);
  const lastId = rows.at(-1)?.entry.id;
  if (follow) seenId.current = lastId;

  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    [i18n.language],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    getItemKey: (index) => rows[index]?.entry.id ?? index,
    overscan: 12,
  });

  useLayoutEffect(() => {
    if (follow && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [follow, lastId, rows.length, virtualizer]);

  const unseen =
    follow || seenId.current === undefined
      ? 0
      : rows.filter((row) => row.entry.id > (seenId.current ?? 0)).length;

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK_PX;
    if (atBottom && !follow) onFollowChange(true);
    else if (!atBottom && follow && Date.now() - userAt.current < USER_SCROLL_MS) {
      onFollowChange(false);
    }
  };
  const markUser = (): void => {
    userAt.current = Date.now();
  };

  return (
    <div className={styles.viewWrap}>
      <div
        ref={scrollRef}
        className={styles.viewport}
        role="region"
        aria-label={label}
        // Прокрутка клавиатурой: область фокусируемая, как у любого прокручиваемого блока.
        tabIndex={0}
        onScroll={onScroll}
        onWheel={markUser}
        onPointerDown={markUser}
        onTouchMove={markUser}
        onKeyDown={(event) => {
          if (SCROLL_KEYS.has(event.key)) markUser();
        }}
      >
        <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const id = row.entry.id;
            const time = row.entry.at ? timeFormat.format(new Date(row.entry.at)) : undefined;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className={styles.virtualRow}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <LogLineRow
                  row={row}
                  search={search}
                  showService={showService}
                  {...(time ? { time } : {})}
                  isSelected={id === selectedId}
                  onToggle={() => onSelect(id === selectedId ? undefined : id)}
                  {...(onAsk ? { onAsk: () => onAsk(row.entry) } : {})}
                />
              </div>
            );
          })}
        </div>
      </div>
      {unseen > 0 && (
        <Button
          className={styles.newLines}
          variant="primary"
          size="sm"
          leftIcon={<Icon name="chevronDown" size={14} />}
          onClick={() => onFollowChange(true)}
        >
          {t('environment.logs.view.newLines', { count: unseen })}
        </Button>
      )}
    </div>
  );
}
