import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { TONE_ICON } from '@shared/config/toast-tone-icon';
import type { ToastDetailsModalProps } from './toast-details-modal.types';
import styles from './toast.module.scss';

/**
 * Полный текст уведомления в окне. Тост показывает три строки и исчезает через
 * три секунды — этого хватает, чтобы понять «получилось или нет», и не хватает,
 * чтобы прочитать вывод команды на сотню файлов. Окно держит тот же текст
 * целиком, с переносами и прокруткой, и его размер не пляшет от длины вывода.
 *
 * Работает и от живого тоста, и от записи журнала: источник разный, читателю
 * нужна одна карточка.
 */
export function ToastDetailsModal({ details, onClose }: ToastDetailsModalProps) {
  const { t } = useTranslation();

  const copy = (): void => {
    if (!details) return;
    void navigator.clipboard.writeText(details.message).then(() => {
      toast.success(t('toasts.copied'));
    });
  };

  return (
    <Modal
      isOpen={Boolean(details)}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      title={details?.title ?? t('notifications.detailsTitle')}
      size="md"
      bodyFill
      footer={
        <Button
          variant="secondary"
          leftIcon={<Icon name="copy" size={16} />}
          onClick={copy}
          disabled={!details}
        >
          {t('notifications.copy')}
        </Button>
      }
    >
      <div className={styles.detailsBody}>
        <span
          className={[styles.detailsIcon, details ? styles[details.tone] : ''].join(' ')}
          aria-hidden="true"
        >
          <Icon name={details ? TONE_ICON[details.tone] : 'info'} size={20} />
        </span>
        {/* Вывод команды читается только с исходными переносами — потому pre, а не абзац. */}
        <pre className={styles.detailsText}>{details?.message}</pre>
      </div>
    </Modal>
  );
}
