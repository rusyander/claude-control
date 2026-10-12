import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Icon } from '@shared/ui/icon';
import type { GuardRemoveZoneProps } from './BackendGuard.types';
import styles from './BackendGuard.module.scss';

/**
 * Снятие — отдельным блоком внизу и с подтверждением: снятая защита молча
 * перестаёт спрашивать, и узнать об этом можно только по уже выполненной команде.
 */
export function GuardRemoveZone({ groupName, isBusy, onRemove }: GuardRemoveZoneProps) {
  const { t } = useTranslation();
  const [isConfirmOpen, setConfirmOpen] = useState(false);

  return (
    <section className={styles.zone} aria-labelledby="guard-remove-title">
      <h3 id="guard-remove-title" className={styles.sectionTitle}>
        {t('environment.guard.remove.title')}
      </h3>
      <p className={styles.sub}>{t('environment.guard.remove.text')}</p>
      <div>
        <Button
          variant="danger"
          size="sm"
          leftIcon={<Icon name="trash" size={16} />}
          disabled={isBusy}
          onClick={() => setConfirmOpen(true)}
        >
          {t('environment.guard.remove.button')}
        </Button>
      </div>
      <ConfirmDialog
        isOpen={isConfirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          onRemove();
        }}
        title={t('environment.guard.remove.confirmTitle')}
        description={t('environment.guard.remove.confirmText', { group: groupName })}
        confirmLabel={t('environment.guard.remove.confirmLabel')}
      />
    </section>
  );
}
