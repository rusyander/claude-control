import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { defaultSelection, isAllSelected, selectableEntries } from './model/EnvTransferPlan';
import { EnvTransferChecklist } from './EnvTransferChecklist';
import { STATUS_TONE } from './EnvTransferImportModal.constants';
import type { EnvTransferImportModalProps } from './EnvTransferImportModal.types';
import styles from './EnvTransferCard.module.scss';

/**
 * План разворота архива: по каждой записи видно, появится она впервые, уже
 * лежит такой же или ПЕРЕЗАПИШЕТ существующий файл.
 *
 * Отмечено по умолчанию только новое: перезапись своей конфигурации чужой —
 * решение пользователя, а не умолчание панели. Совпадающие записи отмечать
 * бессмысленно, нерешённые отметить нельзя вовсе.
 */
export function EnvTransferImportModal({
  plan,
  isBusy,
  onApply,
  onClose,
}: EnvTransferImportModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (plan) setSelected(new Set(defaultSelection(plan.entries)));
  }, [plan]);

  if (!plan) return null;

  const toggle = (archivePath: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(archivePath)) next.delete(archivePath);
      else next.add(archivePath);
      return next;
    });
  };

  const selectable = selectableEntries(plan.entries);
  const allSelected = isAllSelected(plan.entries, selected);

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={t('envTransfer.planTitle', { provider: plan.provider.name })}
      description={t('envTransfer.planDesc', {
        platform: plan.sourcePlatform,
        date: plan.exportedAt.slice(0, 10),
      })}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            isLoading={isBusy}
            disabled={selected.size === 0}
            onClick={() => onApply([...selected])}
          >
            {t('envTransfer.applySelected', { count: selected.size })}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography variant="body-sm">
            {t('envTransfer.planCounts', {
              added: plan.counts.new,
              same: plan.counts.same,
              differs: plan.counts.differs,
            })}
          </Typography>
          {plan.counts.unresolved > 0 && (
            <Badge tone="danger">
              {t('envTransfer.planUnresolved', { count: plan.counts.unresolved })}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSelected(
                allSelected ? new Set() : new Set(selectable.map((entry) => entry.archivePath)),
              )
            }
          >
            {allSelected ? t('envTransfer.selectNone') : t('envTransfer.selectAll')}
          </Button>
        </Stack>

        <div className={styles.entries}>
          {plan.entries.map((entry) => (
            <label
              key={entry.archivePath}
              className={styles.entry}
              title={entry.targetPath ?? entry.problem}
            >
              <input
                type="checkbox"
                checked={selected.has(entry.archivePath)}
                disabled={entry.status === 'unresolved'}
                onChange={() => toggle(entry.archivePath)}
              />
              <Typography variant="body-sm" as="span" truncate className={styles.entryName}>
                {entry.relative}
              </Typography>
              <Badge tone={STATUS_TONE[entry.status]}>
                {t(`envTransfer.status_${entry.status}`)}
              </Badge>
            </label>
          ))}
        </div>

        <EnvTransferChecklist items={plan.checklist} />
      </Stack>
    </Modal>
  );
}
