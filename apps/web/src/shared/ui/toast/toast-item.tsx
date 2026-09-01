import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/**
 * Одна карточка уведомления: сама себя закрывает по таймеру, пауза на наведении.
 *
 * Текст обрезан тремя строками намеренно. Вывод команды на сотню файлов иначе
 * растягивал карточку выше экрана, и вместе с её верхом за край уезжал крестик —
 * уведомление становилось незакрываемым. Полный текст открывается окном по клику.
 */
export function ToastItem({ toast, onDismiss, onShowDetails }: ToastItemProps) {
  const { t } = useTranslation();
  const isReduced = useReducedMotion();
  const [isPaused, setIsPaused] = useState(false);
  const [isClamped, setIsClamped] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  useEffect(() => {
    // duration = 0 означает «висеть до закрытия вручную».
    if (toast.duration <= 0 || isPaused) return;
    timerRef.current = setTimeout(dismiss, toast.duration);
    return () => clearTimeout(timerRef.current);
  }, [toast.duration, isPaused, dismiss]);

  // «Подробнее» предлагаем только когда текст правда не поместился: у короткого
  // сообщения приглашение открыть окно с тем же текстом только сбивает с толку.
  //
  // Замер живёт на callback-ref, а не в useEffect с ref.current: как только текст
  // признан обрезанным, тело карточки меняет тег (div → button), старый span
  // выпадает из документа и отдаёт нулевые размеры. Эффект остался бы подписан на
  // этот мёртвый узел и сбросил бы флаг обратно — карточка мигала бы и никогда не
  // становилась кликабельной. Callback-ref переподписывается на новый узел сам.
  const measureMessage = useCallback((element: HTMLElement | null) => {
    if (!element) return;

    const check = (): void => {
      // Узел уже заменён при перерисовке — мерить нечего, ответит нулями.
      if (!element.isConnected) return;
      setIsClamped(element.scrollHeight > element.clientHeight + 1);
    };
    check();

    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const showDetails = (): void =>
    onShowDetails({ tone: toast.tone, message: toast.message, title: toast.title });

  const body = (
    <>
      {toast.title && (
        <Typography variant="body-sm" weight="medium" as="span" clamp={1}>
          {toast.title}
        </Typography>
      )}
      <Typography
        ref={measureMessage}
        variant="body-sm"
        color={toast.title ? 'muted' : 'default'}
        as="span"
        clamp={3}
        className={styles.message}
      >
        {toast.message}
      </Typography>
      {isClamped && !toast.onClick && (
        <Typography variant="caption" color="accent" as="span" className={styles.more}>
          {t('common.details')}
        </Typography>
      )}
    </>
  );

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

      {toast.onClick || isClamped ? (
        <button
          type="button"
          className={`${styles.body} ${styles.clickable}`}
          onClick={() => {
            // Своё действие тоста важнее: у него длинного текста и не бывает.
            if (toast.onClick) {
              toast.onClick();
              dismiss();
              return;
            }
            showDetails();
          }}
        >
          {body}
        </button>
      ) : (
        <Stack gap="var(--spacing-3xs)" className={styles.body}>
          {body}
        </Stack>
      )}

      <button
        type="button"
        className={styles.close}
        onClick={dismiss}
        aria-label={t('common.close')}
      >
        <Icon name="close" size={16} />
      </button>
    </motion.li>
  );
}
