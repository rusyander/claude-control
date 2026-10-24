import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import {
  DeferredAskList,
  openAsks,
  useDecideWithToast,
  useDeferredAsks,
  waitingCount,
  type DeferredAskView,
} from '@entities/DeferredAsk';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { DeferredAsksBannerViewProps } from './DeferredAsksBanner.types';
import styles from './DeferredAsksBanner.module.scss';

/**
 * Плашка «Ждёт решения (n)» над любым разделом: вызовы, которые решает только
 * человек, агенты поставили в список и работают дальше (решение владельца 23.10).
 * Человек, вернувшийся через часы, видит их одним списком и отвечает отсюда же;
 * ответ продолжает работу ровно с этим вызовом. Пусто — плашки нет.
 */
export function DeferredAsksBanner() {
  const { data } = useDeferredAsks();
  const navigate = useNavigate();
  const { onDecide, busyId } = useDecideWithToast();
  return (
    <DeferredAsksBannerView
      items={data?.items ?? []}
      onDecide={onDecide}
      {...(busyId ? { busyId } : {})}
      onOpenChat={(id) => void navigate({ to: '/chat', search: { id } } as never)}
    />
  );
}

/** Сама плашка без запросов — её рисуют и тесты. */
export function DeferredAsksBannerView({
  items,
  onDecide,
  busyId,
  onOpenChat,
  defaultOpen = false,
}: DeferredAsksBannerViewProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const count = waitingCount(items);
  if (count === 0) return null;
  const open: DeferredAskView[] = openAsks(items);

  return (
    <section
      className={styles.root}
      data-deferred-banner={count}
      aria-label={t('deferredAsks.badge', { count })}
    >
      <div className={styles.head}>
        <div className={styles.text}>
          <Typography variant="body" weight="semibold">
            {t('deferredAsks.badge', { count })}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('deferredAsks.hint')}
          </Typography>
        </div>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((value) => !value)}
        >
          {t(isOpen ? 'deferredAsks.hide' : 'deferredAsks.show')}
        </Button>
      </div>
      {isOpen && (
        <DeferredAskList
          items={open}
          onDecide={onDecide}
          {...(busyId ? { busyId } : {})}
          {...(onOpenChat ? { onOpenChat } : {})}
          filterable
        />
      )}
    </section>
  );
}
