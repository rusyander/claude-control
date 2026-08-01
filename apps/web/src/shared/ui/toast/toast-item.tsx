import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion';
import { DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { TONE_ICON } from '@shared/config/toast-tone-icon';
import { TOAST_VARIANTS, TONE_ROLE } from './toast-item.constants';
import type { ToastItemProps } from './toast-item.types';
import styles from './toast.module.scss';

/** Одна карточка уведомления: сама себя закрывает по таймеру, пауза на наведении. */
export function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const isReduced = useReducedMotion();
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  useEffect(() => {
    // duration = 0 означает «висеть до закрытия вручную».
    if (toast.duration <= 0 || isPaused) return;
    timerRef.current = setTimeout(dismiss, toast.duration);
    return () => clearTimeout(timerRef.current);
  }, [toast.duration, isPaused, dismiss]);

  return (
    <motion.li
      layout
      className={[styles.toast, styles[toast.tone]].join(' ')}
      role={TONE_ROLE[toast.tone]}
      aria-live={TONE_ROLE[toast.tone] === 'alert' ? 'assertive' : 'polite'}
      variants={TOAST_VARIANTS}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced)}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon name={TONE_ICON[toast.tone]} size={20} />
      </span>

      {toast.onClick ? (
        <button
          type="button"
          className={`${styles.body} ${styles.clickable}`}
          onClick={() => {
            toast.onClick?.();
            dismiss();
          }}
        >
          {toast.title && (
            <Typography variant="body-sm" weight="medium" as="span">
              {toast.title}
            </Typography>
          )}
          <Typography variant="body-sm" color={toast.title ? 'muted' : 'default'} as="span">
            {toast.message}
          </Typography>
        </button>
      ) : (
        <Stack gap="var(--spacing-3xs)" className={styles.body}>
          {toast.title && (
            <Typography variant="body-sm" weight="medium" as="span">
              {toast.title}
            </Typography>
          )}
          <Typography variant="body-sm" color={toast.title ? 'muted' : 'default'} as="span">
            {toast.message}
          </Typography>
        </Stack>
      )}

      <button type="button" className={styles.close} onClick={dismiss} aria-label="Закрыть">
        <Icon name="close" size={16} />
      </button>
    </motion.li>
  );
}
