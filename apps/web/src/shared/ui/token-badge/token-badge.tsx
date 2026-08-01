import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTokens } from '@shared/lib/format';
import type { TokenBadgeProps } from './token-badge.types';
import styles from './token-badge.module.scss';

/**
 * Расход токенов на одно действие агента.
 *
 * Зачем два числа. Полная сумма почти на каждом шаге равна размеру контекста и
 * состоит в основном из чтения кэша — по ней дешёвый `Read` не отличить от
 * тяжёлой генерации. Поэтому рядом с общим объёмом (приглушённо) идёт объём
 * НОВОЙ работы (акцентом): свежий вход, запись в кэш и сгенерированное. Именно
 * он и стоит денег — чтение кэша дешевле входа примерно в десять раз.
 *
 * Раскрытие — по наведению, а не по клику: цифра справочная, и требовать ради
 * неё щелчка значило бы делать беглый взгляд платным. Уведённая в само
 * раскрытие мышь его не закрывает (числа можно выделить и скопировать), клик
 * закрепляет до следующего клика или Escape, а с клавиатуры работает фокус.
 */
export function TokenBadge({
  usage,
  unit = 'tokens',
  sharedWith,
  effort,
  label,
  className,
}: TokenBadgeProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
  // Новое — всё, кроме чтения кэша: только оно и есть работа этого шага.
  const fresh = usage.input + usage.output + usage.cacheCreation;
  const isOpen = hovered || pinned;

  // Закрепление снимается кликом мимо и Escape — иначе раскрытие,
  // оставленное открытым, перекрывало бы соседние строки ленты.
  useEffect(() => {
    if (!pinned) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPinned(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pinned]);

  const rows = [
    { key: 'input', value: usage.input, tone: styles.barInput },
    { key: 'cacheCreation', value: usage.cacheCreation, tone: styles.barWrite },
    { key: 'cacheRead', value: usage.cacheRead, tone: styles.barRead },
    { key: 'output', value: usage.output, tone: styles.barOutput },
  ];

  return (
    <span
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles.badge}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={t('chat.usage.badgeLabel', { total: formatTokens(total) })}
        onClick={() => setPinned((value) => !value)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        {unit === 'money' && usage.costUsd !== undefined ? (
          <span className={styles.fresh}>${usage.costUsd.toFixed(3)}</span>
        ) : (
          <>
            <span className={styles.total}>{formatTokens(total)}</span>
            <span className={styles.fresh}>+{formatTokens(fresh)}</span>
          </>
        )}
      </button>

      {isOpen && (
        <span id={panelId} role="tooltip" className={styles.panel}>
          <span className={styles.head}>
            <span className={styles.title}>{label ?? t('chat.usage.title')}</span>
            {usage.model && <span className={styles.model}>{usage.model}</span>}
          </span>

          {/* Пропорция видов: доли читаются быстрее, чем четыре числа подряд. */}
          <span className={styles.bar} aria-hidden="true">
            {rows.map((row) =>
              row.value > 0 ? (
                <span
                  key={row.key}
                  className={row.tone}
                  style={{ width: `${(row.value / total) * 100}%` }}
                />
              ) : null,
            )}
          </span>

          <span className={styles.rows}>
            {rows.map((row) => (
              <span key={row.key} className={styles.row}>
                <span className={styles.rowName}>
                  <span className={`${styles.dot} ${row.tone}`} aria-hidden="true" />
                  {t(`chat.usage.${row.key}`)}
                </span>
                <span className={styles.rowValue}>
                  {formatTokens(row.value)}
                  <span className={styles.share}>
                    {total > 0 ? Math.round((row.value / total) * 100) : 0}%
                  </span>
                </span>
              </span>
            ))}
          </span>

          <span className={styles.foot}>
            <span className={styles.row}>
              <span className={styles.rowName}>{t('chat.usage.total')}</span>
              <span className={styles.rowValue}>{formatTokens(total)}</span>
            </span>
            {usage.costUsd !== undefined && (
              <span className={styles.row}>
                <span className={styles.rowName}>{t('chat.usage.cost')}</span>
                <span className={styles.rowValue}>${usage.costUsd.toFixed(4)}</span>
              </span>
            )}
            {effort && (
              <span className={styles.row}>
                <span className={styles.rowName}>{t('chat.usage.effort')}</span>
                <span className={styles.rowValue}>{effort}</span>
              </span>
            )}
          </span>

          {sharedWith !== undefined && sharedWith > 1 && (
            <span className={styles.note}>{t('chat.usage.shared', { count: sharedWith })}</span>
          )}
        </span>
      )}
    </span>
  );
}
