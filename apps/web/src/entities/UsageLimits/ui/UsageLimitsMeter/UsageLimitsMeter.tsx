import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageLimitWindow } from '@agentdeck/contracts';
import { useUsageLimits } from '../../api/useUsageLimits';
import { formatLimitPercent } from '../../model/formatLimitPercent';
import { formatResetAt } from '../../model/formatResetAt';
import { formatUntil } from '../../model/formatUntil';
import { limitTone } from '../../model/limitTone';
import { windowLabel } from '../../model/windowLabel';
import type { UsageLimitsMeterProps, UsageLimitsViewProps } from './UsageLimitsMeter.types';
import styles from './UsageLimitsMeter.module.scss';

/**
 * Лимиты подписки Claude — блок вверху боковой панели, на каждой странице:
 * сессия (5 часов), неделя и неделя модели, если сервер её делит. Процент — как
 * его дал сервер (до трёх знаков, без дописанных нулей), полоса, момент сброса;
 * подробности — в подсказке. Свёрнутая панель — только проценты столбиком.
 *
 * Данные — `GET /api/usage-limits` из кэша сервера; живое обновление — событие
 * `usage-limits` потока `/api/events`. Ключ API вместо подписки — блока нет.
 */
export function UsageLimitsMeter({ isCollapsed = false }: UsageLimitsMeterProps) {
  const { data } = useUsageLimits();
  const now = useMinuteClock();
  if (!data || data.status === 'api-key') return null;
  return <UsageLimitsView limits={data} now={now} isCollapsed={isCollapsed} />;
}

/**
 * Часы с шагом в полминуты: «сегодня / пн» у сброса и «через N мин» в подсказке
 * считаются от «сейчас», а одинаковый ответ сервера перерисовки не вызывает.
 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_STEP_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const CLOCK_STEP_MS = 30_000;

/** Сам вид — без запроса: его рисует и тест. */
export function UsageLimitsView({ limits, now, isCollapsed = false }: UsageLimitsViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const reason = limits.status === 'ok' ? '' : t(`usageLimits.status.${limits.status}`);
  const observed =
    limits.observedAt !== null && limits.source
      ? t('usageLimits.tooltipObserved', {
          time: new Date(limits.observedAt).toLocaleTimeString(locale, {
            hour: '2-digit',
            minute: '2-digit',
          }),
          source: t(`usageLimits.source.${limits.source}`),
        })
      : '';

  const resetText = (window: UsageLimitWindow): string =>
    window.resetsAt === null
      ? t('usageLimits.resetUnknown')
      : t('usageLimits.reset', { time: formatResetAt(window.resetsAt, now, locale) });

  const tooltipOf = (window: UsageLimitWindow): string => {
    const label = windowLabel(window, t);
    const lines = [
      t('usageLimits.tooltipUsed', { label, percent: formatLimitPercent(window.percent) }),
    ];
    if (window.resetsAt !== null) {
      lines.push(
        t('usageLimits.tooltipReset', {
          time: new Date(window.resetsAt).toLocaleString(locale, {
            weekday: 'short',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
          until: formatUntil(window.resetsAt - now, t),
        }),
      );
    }
    if (observed) lines.push(observed);
    if (reason) lines.push(reason);
    return lines.join('\n');
  };

  if (limits.windows.length === 0) {
    // Окон нет — одна приглушённая строка с причиной (в свёрнутой — прочерк).
    return (
      <section
        className={styles.root}
        aria-label={t('usageLimits.title')}
        data-usage-limits
        data-usage-status={limits.status}
        title={reason}
      >
        <span className={styles.empty}>{isCollapsed ? '—' : reason}</span>
      </section>
    );
  }

  const isStale = limits.status !== 'ok';
  return (
    <section
      className={styles.root}
      aria-label={t('usageLimits.title')}
      data-usage-limits
      data-usage-status={limits.status}
      data-collapsed={isCollapsed || undefined}
    >
      {!isCollapsed && (
        <div className={styles.header}>
          <span>{t('usageLimits.title')}</span>
          {isStale && (
            <span className={styles.stale} title={[reason, observed].filter(Boolean).join('\n')}>
              {t('usageLimits.stale')}
            </span>
          )}
        </div>
      )}
      {limits.windows.map((window) => {
        const label = windowLabel(window, t);
        const percent = formatLimitPercent(window.percent);
        const width = `${Math.min(100, Math.max(0, window.percent))}%`;
        return (
          <div
            key={window.id}
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, window.percent)}
            aria-valuetext={t('usageLimits.aria', { label, percent, reset: resetText(window) })}
            className={styles.window}
            data-tone={limitTone(window.percent)}
            data-stale={isStale || undefined}
            data-limit-id={window.id}
            title={tooltipOf(window)}
          >
            {isCollapsed ? (
              // Рейка узкая: целое число процентов, точное значение — в подсказке.
              <span className={styles.percent}>{Math.floor(window.percent)}%</span>
            ) : (
              <span className={styles.line}>
                <span className={styles.label}>{label}</span>
                <span className={styles.reset}>{resetText(window)}</span>
                <span className={styles.percent}>{percent}</span>
              </span>
            )}
            <span className={styles.track} aria-hidden>
              <span className={styles.fill} style={{ width }} />
            </span>
          </div>
        );
      })}
    </section>
  );
}
