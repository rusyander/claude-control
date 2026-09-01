import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useToastHistory,
  markToastsRead,
  clearToastHistory,
  type ToastHistoryEntry,
} from '@shared/lib/toast';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { EmptyState } from '@shared/ui/empty-state';
import { ToastDetailsModal, type ToastDetails } from '@shared/ui/toast';
import { TONE_ICON } from '@shared/config/toast-tone-icon';
import { formatRelative } from './notification-center.lib';
import type { NotificationCenterProps } from './notification-center.types';
import styles from './notification-center.module.scss';

/**
 * Журнал уведомлений: колокольчик со счётчиком непрочитанных и окно со списком
 * последних тостов и временем. Показ самих тостов не трогает — только даёт
 * вернуться к тем, что уже исчезли с экрана. Живёт в боковой панели, поэтому
 * знает про свёрнутое состояние.
 *
 * Запись показывает те же три строки, что и тост: длинный вывод команды читают
 * не в списке, а в окне, которое открывается кликом по записи.
 */
export function NotificationCenter({ isCollapsed = false }: NotificationCenterProps) {
  const { t, i18n } = useTranslation();
  const { entries, unread } = useToastHistory();
  const [isOpen, setIsOpen] = useState(false);
  const [details, setDetails] = useState<ToastDetails | null>(null);

  const open = (): void => {
    setIsOpen(true);
    // Открыли журнал — значит прочитали: счётчик гасим.
    markToastsRead();
  };

  const now = Date.now();

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={open}
        title={isCollapsed ? t('notifications.title') : undefined}
        aria-label={t('notifications.title')}
      >
        <span className={styles.iconWrap}>
          <Icon name="bell" size={24} />
          {unread > 0 && (
            <span className={styles.badge} aria-hidden="true">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </span>
        <span className={styles.label}>{t('notifications.title')}</span>
      </button>

      <Modal
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        title={t('notifications.title')}
        description={t('notifications.subtitle')}
        size="sm"
        bodyFill
        footer={
          entries.length > 0 ? (
            <Button variant="secondary" onClick={() => clearToastHistory()}>
              {t('notifications.clear')}
            </Button>
          ) : undefined
        }
      >
        {entries.length === 0 ? (
          <EmptyState
            icon="bell"
            title={t('notifications.emptyTitle')}
            text={t('notifications.emptyText')}
          />
        ) : (
          <Stack as="ul" gap="var(--spacing-2xs)" className={styles.list}>
            {entries.map((entry: ToastHistoryEntry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={[styles.entry, styles[entry.tone]].join(' ')}
                  onClick={() => setDetails(entry)}
                >
                  <Stack direction="row" gap="var(--spacing-sm)">
                    <Icon name={TONE_ICON[entry.tone]} size={20} className={styles.entryIcon} />
                    <Stack gap="var(--spacing-3xs)" minWidth={0} flex={1}>
                      {entry.title && (
                        <Typography variant="body-sm" weight="medium" as="span" clamp={1}>
                          {entry.title}
                        </Typography>
                      )}
                      <Typography
                        variant="body-sm"
                        color={entry.title ? 'muted' : 'default'}
                        as="span"
                        clamp={3}
                        className={styles.entryMessage}
                      >
                        {entry.message}
                      </Typography>
                      <Typography variant="caption" color="subtle" as="span">
                        {formatRelative(entry.at, now, i18n.language)}
                      </Typography>
                    </Stack>
                  </Stack>
                </button>
              </li>
            ))}
          </Stack>
        )}
      </Modal>

      <ToastDetailsModal details={details} onClose={() => setDetails(null)} />
    </>
  );
}
