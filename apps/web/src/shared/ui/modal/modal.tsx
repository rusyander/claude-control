import { useLayoutEffect, useRef } from 'react';
import { Root, Portal, Overlay, Content, Title, Description, Close } from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { DIALOG, FADE, DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { useBesideDockDialog } from '@shared/hooks/use-beside-dock-dialog';
import { Stack } from '@shared/ui/stack';
import { CodeText, Typography } from '@shared/ui/typography';
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
  headerActions,
  footer,
  size = 'md',
  bodyFill = false,
  dismissible = true,
}: ModalProps) {
  const { t } = useTranslation();
  const isReduced = useReducedMotion();

  const fade = withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced);
  const dialog = withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced);

  // Окно открывается состоянием, а не Radix-триггером, поэтому после закрытия
  // Radix не знает, куда вернуть фокус, и тот падает на body: с клавиатуры
  // человек оказывается в начале страницы. Запоминаем, что держало фокус в
  // момент открытия, и возвращаем его сами. Layout-эффект — потому что
  // фокус-ловушка Radix забирает фокус в обычном эффекте, то есть позже.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }, [isOpen]);
  const restoreOpenerFocus = (event: Event): void => {
    const opener = openerRef.current;
    if (!opener?.isConnected) return;
    event.preventDefault();
    opener.focus();
  };

  // Недискриминируемое окно не закрывается ни Escape, ни кликом мимо: Radix
  // сообщил бы onOpenChange(false), а мы его глушим здесь и запрещаем сами
  // события ниже — иначе крестика нет, а окно всё равно пропадает по Escape.
  const handleOpenChange = (next: boolean): void => {
    if (!next && !dismissible) return;
    onOpenChange(next);
  };
  const block = dismissible ? undefined : (event: Event): void => event.preventDefault();

  // Открыто пристёгнутое окно (агент панели) и ему хватает места: модальное окно
  // встаёт слева от него, а не поверх (`@shared/lib/side-dock`).
  const { besideDock, onInteractOutside, onEscapeKeyDown } = useBesideDockDialog(isOpen, block);
  const besideClass = besideDock ? styles.besideDock : undefined;

  return (
    <Root open={isOpen} onOpenChange={handleOpenChange} modal={!besideDock}>
      {/*
        forceMount отдаёт управление показом AnimatePresence: без него Radix
        снимает окно с экрана мгновенно, и анимации закрытия не существует —
        окно просто исчезает, а затемнение моргает.
      */}
      <AnimatePresence>
        {isOpen && (
          <Portal forceMount>
            {besideDock ? (
              // Без режима модальности Radix затемнение не рисует — своё, слева от окна.
              <motion.div
                className={[styles.overlay, besideClass].join(' ')}
                aria-hidden="true"
                data-modal-beside-dock
                variants={FADE}
                initial="hidden"
                animate="visible"
                exit="hidden"
                transition={fade}
              />
            ) : (
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
            )}

            <Content
              asChild
              forceMount
              onEscapeKeyDown={onEscapeKeyDown}
              onPointerDownOutside={block}
              onInteractOutside={onInteractOutside}
              onCloseAutoFocus={restoreOpenerFocus}
            >
              <motion.div
                className={[styles.content, styles[size], besideClass].filter(Boolean).join(' ')}
                data-modal-size={size}
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
                        <CodeText text={description} />
                      </Typography>
                    </Description>
                  )}
                  {headerActions && <div className={styles.headerActions}>{headerActions}</div>}
                </Stack>

                {dismissible && (
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
                )}

                <div
                  className={[styles.body, bodyFill && styles.bodyFill].filter(Boolean).join(' ')}
                  data-modal-body
                >
                  {children}
                </div>

                {footer && <div className={styles.footer}>{footer}</div>}
              </motion.div>
            </Content>
          </Portal>
        )}
      </AnimatePresence>
    </Root>
  );
}
