import { Root, Portal, Overlay, Content, Title, Description, Close } from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
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

  return (
    <Root open={isOpen} onOpenChange={onOpenChange}>
      <Portal>
        <Overlay className={styles.overlay} />
        <Content className={[styles.content, styles[size]].join(' ')}>
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
        </Content>
      </Portal>
    </Root>
  );
}
