import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { useSettings } from '@entities/AppConfig';
import {
  WATCHER_ANCHOR,
  WATCHER_FOCUS_EVENT,
  WatcherSummary,
  useSetWatcher,
  useWatcherElapsed,
  useWatcherStatus,
  watcherSettingsTab,
  watcherSpendText,
} from '@entities/Watcher';
import { SETTINGS_ROUTE } from '@shared/config/routes';
import { toErrorMessage } from '@shared/api/client';
import { formatDuration } from '@shared/lib/format-duration';
import { toast } from '@shared/lib/toast';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { placePopover } from '../model/placeBeside';
import type { WatcherIndicatorProps } from './WatcherIndicator.types';
import styles from './WatcherIndicator.module.scss';

/** Зазор между краем боковой панели и окном, px. */
const POPOVER_GAP = 8;
/** Окно не прижимается к краям экрана вплотную, px. */
const VIEWPORT_MARGIN = 16;
/** Что внутри окна берёт фокус с клавиатуры. */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Индикатор фонового наблюдателя: строка в боковой панели на каждой странице,
 * пока наблюдатель включён. Выключен — строки нет вовсе: индикатор нужен,
 * чтобы про работающий в фоне агент (и его расход) нельзя было забыть, а не
 * чтобы напоминать о выключенном.
 *
 * Клик открывает окно: сводка, «Выключить» и «Перейти в настройки». Escape и
 * клик мимо закрывают его и возвращают фокус на строку.
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

  // Выключили (здесь, в настройках или с телефона) — окно закрывается вместе
  // со строкой: висеть над страницей без хозяина ему незачем.
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

  if (!status || !enabled) return null;

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

  const goToSettings = (): void => {
    setOpen(false);
    void navigate({
      to: SETTINGS_ROUTE,
      search: { tab: watcherSettingsTab },
      hash: WATCHER_ANCHOR,
    } as never);
    // Уже стоим на этой вкладке — адрес не меняется, и карточке надо сказать
    // отдельно, что фокус снова нужен ей.
    window.dispatchEvent(new Event(WATCHER_FOCUS_EVENT));
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
                <Button variant="ghost" size="sm" onClick={goToSettings} data-watcher-go-settings>
                  {t('watcher.openSettings')}
                </Button>
              </Stack>
            </Stack>
          </div>
        </>
      )}
    </div>
  );
}

/** Высота окна, пока его ещё не нарисовали: первый кадр до замера. */
const POPOVER_HEIGHT_GUESS = 260;
/** Ширина окна до замера — как в стилях (`.popover`). */
const POPOVER_WIDTH_GUESS = 320;

/** Окно у видимого правого края строки; целиком в экране (`placePopover`). */
function placeBeside(trigger: HTMLElement | null, popover: HTMLElement | null): CSSProperties {
  const rect = trigger?.getBoundingClientRect();
  if (!rect) return {};
  const clip = trigger?.closest('nav')?.getBoundingClientRect();
  return placePopover({
    anchor: rect,
    clip,
    width: popover?.offsetWidth || POPOVER_WIDTH_GUESS,
    height: popover?.offsetHeight || POPOVER_HEIGHT_GUESS,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    gap: POPOVER_GAP,
    margin: VIEWPORT_MARGIN,
  });
}
