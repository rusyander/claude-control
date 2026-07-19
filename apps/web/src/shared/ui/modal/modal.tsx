import { Root, Portal, Overlay, Content, Title, Description, Close } from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { DIALOG, FADE, DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import styles from './modal.module.scss';
import type { ModalProps } from './modal.types';

/**
 * Модальное окно на Radix: фокус-ловушка, закрытие по Escape, блокировка
 * прокрутки фона и правильные aria-роли уже реализованы — нам остаются стили.
 */
export function Modal({
  isOpen,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  const { t } = useTranslation();
  const isReduced = useReducedMotion();

  const fade = withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced);
  const dialog = withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced);

  return (
    <Root open={isOpen} onOpenChange={onOpenChange}>
      {/*
        forceMount отдаёт управление показом AnimatePresence: без него Radix
        снимает окно с экрана мгновенно, и анимации закрытия не существует —
        окно просто исчезает, а затемнение моргает.
      */}
      <AnimatePresence>
        {isOpen && (
          <Portal forceMount>
            <Overlay asChild forceMount>
              <motion.div
                className={styles.overlay}
                variants={FADE}
                initial="hidden"
                animate="visible"
                exit="hidden"
                transition={fade}
              />
            </Overlay>

            <Content asChild forceMount>
              <motion.div
                className={[styles.content, styles[size]].join(' ')}
                variants={DIALOG}
                initial="hidden"
                animate="visible"
                exit="hidden"
                transition={dialog}
              >
                <Stack className={styles.header} gap="var(--spacing-3xs)">
                  <Title asChild>
                    <Typography variant="heading-sm">{title}</Typography>
                  </Title>
                  {description && (
                    <Description asChild>
                      <Typography variant="body-sm" color="muted">
                        {description}
                      </Typography>
                    </Description>
                  )}
                </Stack>

                <Close asChild>
                  <Button
                    className={styles.closeButton}
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Icon name="close" size={24} />}
                    aria-label={t('common.close')}
                  />
                </Close>

                <div className={styles.body}>{children}</div>

                {footer && <div className={styles.footer}>{footer}</div>}
              </motion.div>
            </Content>
          </Portal>
        )}
      </AnimatePresence>
    </Root>
  );
}
