import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { HELP_ROUTE } from '@shared/config/routes';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import type { ChatHeaderMenuProps } from './ChatHeaderMenu.types';
import styles from './ChatHeaderMenu.module.scss';

/**
 * Меню шапки чата: тумблеры прав, выгрузка разговора, обновление и справка.
 *
 * Всё это стояло в шапке в один ряд и вытесняло оттуда то, ради чего в шапку и
 * смотрят, — название разговора, пульт агентов, выбор модели. Тумблеры при этом
 * трогают редко: положение переживает перезагрузку, и после первой настройки к
 * ним не возвращаются неделями. Поэтому они здесь, за одной кнопкой, а в ряду
 * остаётся работа.
 */
export function ChatHeaderMenu({
  allowEdits,
  onAllowEditsChange,
  autoApprove,
  onAutoApproveChange,
  canExport,
  onExport,
  onRefresh,
}: ChatHeaderMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Escape закрывает меню и возвращает фокус на кнопку: без возврата клавиатура
  // оказывается в начале страницы, а человек — там, где не был.
  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const showEdits = allowEdits !== undefined && onAllowEditsChange !== undefined;

  return (
    <div
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        leftIcon={<Icon name="settings" size={20} />}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title={t('chat.menuHint')}
      >
        {t('chat.menu')}
      </Button>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label={t('chat.menu')}>
            <Typography
              variant="caption"
              color="subtle"
              as="span"
              className={styles.groupTitle}
              id="chat-menu-permissions"
            >
              {t('chat.menuPermissions')}
            </Typography>

            {/* Автоподтверждение: панель сама разрешает обратимое, а
                безвозвратное (удаление, затирание истории, снос данных) и всё
                под правилами ask/deny по-прежнему спрашивает. Чтение файлов
                разрешается всегда — независимо от этого тумблера. */}
            <Stack
              as="label"
              direction="row"
              align="center"
              gap="var(--spacing-2xs)"
              className={styles.row}
              title={t('chat.autoApproveHint')}
            >
              <Toggle
                size="sm"
                checked={autoApprove}
                onCheckedChange={onAutoApproveChange}
                aria-label={t('chat.autoApprove')}
              />
              <Typography variant="body-sm" color={autoApprove ? 'default' : 'subtle'} as="span">
                {autoApprove ? t('chat.autoApproveOn') : t('chat.autoApproveOff')}
              </Typography>
            </Stack>

            {showEdits && (
              <Stack
                as="label"
                direction="row"
                align="center"
                gap="var(--spacing-2xs)"
                className={styles.row}
              >
                <Toggle
                  size="sm"
                  checked={allowEdits}
                  onCheckedChange={onAllowEditsChange}
                  aria-label={t('chat.allowEdits')}
                />
                <Typography variant="body-sm" color={allowEdits ? 'default' : 'subtle'} as="span">
                  {allowEdits ? t('chat.editsAllowed') : t('chat.readOnly')}
                </Typography>
              </Stack>
            )}

            <div className={styles.divider} />

            <Typography variant="caption" color="subtle" as="span" className={styles.groupTitle}>
              {t('chat.menuActions')}
            </Typography>

            {canExport && (
              <button
                type="button"
                className={styles.item}
                onClick={() => {
                  onExport();
                  close();
                }}
                title={t('chat.exportHint')}
              >
                <Icon name="file" size={20} />
                {t('chat.export')}
              </button>
            )}

            <button
              type="button"
              className={styles.item}
              onClick={() => {
                onRefresh();
                close();
              }}
            >
              <Icon name="refresh" size={20} />
              {t('common.refresh')}
            </button>

            <Link
              to={HELP_ROUTE}
              search={{ topic: 'chat' }}
              className={styles.item}
              onClick={() => setOpen(false)}
            >
              <Icon name="help" size={20} />
              {t('common.openHelp')}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
