import { useTranslation } from 'react-i18next';
import {
  DeferredAskList,
  asksOfParent,
  openAsks,
  useDecideWithToast,
  useDeferredAsks,
  type DeferredAskView,
} from '@entities/DeferredAsk';
import { Typography } from '@shared/ui/typography';
import styles from './HubDeferred.module.scss';

export interface HubDeferredProps {
  parentChatId: string;
  onOpen: (chatId: string) => void;
}

/**
 * Вызовы D-n групп ЭТОГО разделения — в хабе родителя, с фильтром по группе:
 * человек, открывший разделение, отвечает его группам здесь же, не ища их
 * записи в общей плашке среди чужих.
 */
export function HubDeferred({ parentChatId, onOpen }: HubDeferredProps) {
  const { data } = useDeferredAsks();
  const { onDecide, busyId } = useDecideWithToast();
  return (
    <HubDeferredView
      items={openAsks(asksOfParent(data?.items ?? [], parentChatId))}
      onDecide={onDecide}
      {...(busyId ? { busyId } : {})}
      onOpen={onOpen}
    />
  );
}

export interface HubDeferredViewProps {
  items: DeferredAskView[];
  onDecide: (id: string, behavior: 'allow' | 'deny') => void;
  busyId?: string;
  onOpen?: (chatId: string) => void;
}

/** Раздел хаба без запросов — его рисуют и тесты. Пусто — раздела нет. */
export function HubDeferredView({ items, onDecide, busyId, onOpen }: HubDeferredViewProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <section className={styles.root} data-hub-deferred={items.length}>
      <Typography variant="body-sm" weight="semibold" color="warning">
        {t('deferredAsks.hubTitle', { count: items.length })}
      </Typography>
      <DeferredAskList
        items={items}
        onDecide={onDecide}
        {...(busyId ? { busyId } : {})}
        {...(onOpen ? { onOpenChat: onOpen } : {})}
        filterable
      />
    </section>
  );
}
