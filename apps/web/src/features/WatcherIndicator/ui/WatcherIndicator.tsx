import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { useSettings } from '@entities/AppConfig';
import {
  WatcherSummary,
  useSetWatcher,
  useWatcherElapsed,
  useWatcherStatus,
  watcherSpendText,
} from '@entities/Watcher';
import { WATCHER_ROUTE } from '@shared/config/routes';
import { formatDuration } from '@shared/lib/format-duration';
import { toast } from '@shared/lib/toast';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { WatcherIndicatorProps } from './WatcherIndicator.types';
import styles from './WatcherIndicator.module.scss';
import { placeBeside } from '../lib/placeBeside';
import { FOCUSABLE } from './WatcherIndicator.constants';
import { WatcherBugCheck } from './WatcherBugCheck/WatcherBugCheck';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/** Сколько последних проверок видно в окне: остальные — на странице наблюдателя. */
const SHOWN_CHECKS = 3;

/**
 * Индикатор фонового наблюдателя: строка в боковой панели на каждой странице.
 * Видна всегда (владелец 09.10.2026): выключенный наблюдатель — строка «выкл»,
 * клик ведёт на его страницу, где его запускают; раньше строки у выключенного
 * не было, и до запуска приходилось знать дорогу в настройки.
 *
 * Включённый — клик открывает окно: сводка, «Выключить», «Открыть страницу» и
 * форма «Нашли баг сами?» — человек описывает баг словами, а наблюдатель
 * сверяет его с кодом. Escape и клик мимо закрывают окно и возвращают фокус
 * на строку.
 */
export function WatcherIndicator({ isCollapsed = false }: WatcherIndicatorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: status, dataUpdatedAt } = useWatcherStatus();
  const { data: settings } = useSettings();
  const setWatcher = useSetWatcher();
  const elapsed = useWatcherElapsed(status, dataUpdatedAt);
  const [isOpen, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const costUnit = settings?.costUnit ?? 'tokens';

  const enabled = status?.enabled === true;

  // Выключили (здесь, на странице наблюдателя или с телефона) — окно
  // закрывается: управлять в нём больше нечем, строка остаётся ссылкой.
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  // Место окна считается заново, пока оно открыто: сменили размер окна, свернули
  // боковую панель, прокрутили — окно шло за строкой, а не висело там, где
  // его открыли. Высота — настоящая, а не прикидка.
  useEffect(() => {
    if (!isOpen) return undefined;
    const place = (): void => setPosition(placeBeside(triggerRef.current, popoverRef.current));
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen]);

  // Открылось — фокус на первое действие: с клавиатуры окно иначе недостижимо.
  useEffect(() => {
    if (isOpen) popoverRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [isOpen]);

  // Состояние ещё не пришло или наблюдатель выключен — строка ведёт на его
  // страницу: окно со сводкой и формой бага нужно только работающему.
  if (!status || !enabled) {
    return (
      <button
        type="button"
        className={styles.trigger}
        onClick={() => void navigate({ to: WATCHER_ROUTE } as never)}
        title={t('watcher.offTooltip')}
        aria-label={t('watcher.offAria')}
        data-watcher-indicator
        data-watcher-off
      >
        <span className={styles.iconWrap}>
          <Icon name="eye" size={24} />
        </span>
        {!isCollapsed && (
          <span className={styles.label}>
            <span>{t('watcher.short')}</span>
            <span className={styles.time}>{t('watcher.offShort')}</span>
          </span>
        )}
      </button>
    );
  }

  const time = formatDuration(elapsed, t);
  const spend = watcherSpendText(status.spend, costUnit);
  const spendLabel = spend.estimate ? `${spend.text} (${t('watcher.spendEstimate')})` : spend.text;
  const tooltip = [
    t('watcher.tooltip'),
    t('watcher.running', { time }),
    t('watcher.spend', { spend: spendLabel }),
  ].join('\n');

  const open = (): void => {
    setPosition(placeBeside(triggerRef.current, popoverRef.current));
    setOpen(true);
  };

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const turnOff = (): void => {
    setWatcher.mutate(false, {
      onSuccess: () => {
        setOpen(false);
      },
      onError: (error) =>
        toast.error(t('watcher.toggleFailed', { message: toErrorMessage(error) })),
    });
  };

  const openPage = (): void => {
    setOpen(false);
    void navigate({ to: WATCHER_ROUTE } as never);
  };

  return (
    <div
      onKeyDown={(event) => {
        if (!isOpen) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
          return;
        }
        // Окно модальное (подложка ловит клик мимо) — Tab ходит по кругу внутри
        // него, а не уводит фокус на страницу за подложкой.
        if (event.key === 'Tab') {
          const focusable = [
            ...(popoverRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
          ];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          const active = document.activeElement;
          const inside = popoverRef.current?.contains(active) === true;
          if (event.shiftKey && (active === first || !inside)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (active === last || !inside)) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => (isOpen ? close() : open())}
        title={tooltip}
        aria-label={t('watcher.indicatorAria', { time, spend: spendLabel })}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-watcher-indicator
      >
        <span className={styles.iconWrap}>
          <Icon name="eye" size={24} />
          <span
            className={[styles.dot, status.analyzing ? styles.analyzing : '']
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          />
        </span>
        {!isCollapsed && (
          <span className={styles.label}>
            <span>{t('watcher.short')}</span>
            <span className={styles.time}>{time}</span>
          </span>
        )}
      </button>

      {isOpen && (
        <>
          {/* Клик мимо — как Escape: фокус возвращается на строку, а не падает на body. */}
          <div className={styles.backdrop} onClick={close} aria-hidden="true" />
          <div
            ref={popoverRef}
            className={styles.popover}
            style={position}
            role="dialog"
            aria-modal="true"
            aria-label={t('watcher.title')}
            data-watcher-popover
          >
            <Stack gap="var(--spacing-sm)">
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body" weight="medium" as="span">
                  {t('watcher.title')}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {t('watcher.tooltip')}
                </Typography>
              </Stack>
              <WatcherSummary status={status} elapsed={elapsed} costUnit={costUnit} />
              <Stack direction="row" gap="var(--spacing-xs)" wrap>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={turnOff}
                  isLoading={setWatcher.isPending}
                  data-watcher-turn-off
                >
                  {t('watcher.turnOff')}
                </Button>
                <Button variant="secondary" size="sm" onClick={openPage} data-watcher-open-page>
                  {t('watcher.openPage')}
                </Button>
              </Stack>
              <WatcherBugCheck checks={status.checks ?? []} limit={SHOWN_CHECKS} />
            </Stack>
          </div>
        </>
      )}
    </div>
  );
}
