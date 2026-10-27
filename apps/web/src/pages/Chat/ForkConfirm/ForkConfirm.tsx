import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { ForkConfirmProps } from './ForkConfirm.types';

/**
 * «Отправить в новой ветке?» перед отправкой правленой реплики (Telegram 26.10,
 * R2). Не окно удаления: ничего не пропадает, поэтому кнопка основная, а не
 * красная, и имя вводить не нужно. Закрыть окно — то же, что «Отмена».
 */
export function ForkConfirm({ isOpen, onAnswer }: ForkConfirmProps) {
  const { t } = useTranslation();
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onAnswer(false);
      }}
      title={t('chat.fork.confirmTitle')}
      size="fit"
      footer={
        <>
          <Button onClick={() => onAnswer(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => onAnswer(true)} data-fork-confirm>
            {t('chat.fork.confirm')}
          </Button>
        </>
      }
    >
      <Typography variant="body-sm">{t('chat.fork.confirmText')}</Typography>
    </Modal>
  );
}
