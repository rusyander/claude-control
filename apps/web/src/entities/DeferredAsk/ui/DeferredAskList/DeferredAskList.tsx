import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/cn';
import { ownerKey } from '../../model/deferredAsk';
import type { DeferredAskListProps } from './DeferredAskList.types';
import { DeferredAskRow, ownerLabel } from './DeferredAskRow';
import styles from './DeferredAskList.module.scss';

/**
 * Список отложенных вопросов D-n с фильтром «чья запись»: у разделения на
 * десяток групп человек отвечает группе за группой, а не читает общий поток.
 * Фильтр — фишками, одна на группу или чат; пропавший владелец (все его
 * записи решены) сбрасывает фильтр на «все».
 */
export function DeferredAskList({
  items,
  onDecide,
  busyId,
  onOpenChat,
  filterable = false,
}: DeferredAskListProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | undefined>();
  const owners = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    const key = ownerKey(item);
    const known = owners.get(key);
    owners.set(key, { label: known?.label ?? ownerLabel(item, t), count: (known?.count ?? 0) + 1 });
  }
  const filter = picked && owners.has(picked) ? picked : undefined;
  const shown = filter ? items.filter((item) => ownerKey(item) === filter) : items;

  return (
    <div className={styles.root}>
      {filterable && owners.size > 1 && (
        <div className={styles.filters} role="group" data-deferred-filters>
          <button
            type="button"
            className={cn(styles.filter, !filter && styles.filterOn)}
            aria-pressed={!filter}
            onClick={() => setPicked(undefined)}
          >
            {t('deferredAsks.filterAll', { count: items.length })}
          </button>
          {[...owners].map(([key, owner]) => (
            <button
              key={key}
              type="button"
              className={cn(styles.filter, filter === key && styles.filterOn)}
              aria-pressed={filter === key}
              data-deferred-filter={key}
              onClick={() => setPicked(key)}
            >
              {t('deferredAsks.filterOwner', { owner: owner.label, count: owner.count })}
            </button>
          ))}
        </div>
      )}
      <ul className={styles.list}>
        {shown.map((item) => (
          <DeferredAskRow
            key={item.id}
            item={item}
            onDecide={onDecide}
            isBusy={busyId === item.id}
            {...(onOpenChat ? { onOpenChat } : {})}
          />
        ))}
      </ul>
    </div>
  );
}
