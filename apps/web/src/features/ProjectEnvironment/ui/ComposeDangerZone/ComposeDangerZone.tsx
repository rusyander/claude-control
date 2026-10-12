import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Icon } from '@shared/ui/icon';
import type { ComposeDangerZoneProps } from './ComposeDangerZone.types';
import styles from './ComposeDangerZone.module.scss';

/**
 * Удаление стека — отдельным блоком внизу, а не рядом с «Поднять»: промах мимо
 * кнопки не должен стоить контейнеров. Обычное удаление тома оставляет, и
 * подтверждать его незачем; удаление с данными подтверждается и называет тома
 * поимённо — «удалить данные» без списка не говорит, ЧТО пропадёт.
 */
export function ComposeDangerZone({
  volumes,
  isBusy,
  onDown,
  onDownVolumes,
}: ComposeDangerZoneProps) {
  const { t } = useTranslation();
  const [isConfirmOpen, setConfirmOpen] = useState(false);

  return (
    <section className={styles.zone} aria-labelledby="compose-danger-title">
      <h3 id="compose-danger-title" className={styles.title}>
        {t('environment.danger.title')}
      </h3>
      <p className={styles.text}>{t('environment.danger.text')}</p>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="trash" size={16} />}
          disabled={isBusy}
          onClick={onDown}
        >
          {t('environment.danger.down')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          leftIcon={<Icon name="trash" size={16} />}
          disabled={isBusy || volumes.length === 0}
          onClick={() => setConfirmOpen(true)}
        >
          {t('environment.danger.downVolumes')}
        </Button>
      </div>
      {volumes.length === 0 && <p className={styles.text}>{t('environment.danger.noVolumes')}</p>}

      <ConfirmDialog
        isOpen={isConfirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          onDownVolumes();
        }}
        title={t('environment.danger.confirmTitle')}
        description={t('environment.danger.confirmText', { volumes: volumes.join(', ') })}
        confirmLabel={t('environment.danger.confirmLabel')}
      />
    </section>
  );
}
