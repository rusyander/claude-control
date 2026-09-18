import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { serverFieldText } from '@shared/config/i18n';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import {
  defaultPlatformSelection,
  defaultPromptSelection,
  defaultSelection,
  isAllSelected,
  selectableEntries,
} from './model/EnvTransferPlan';
import { EnvTransferChecklist } from './EnvTransferChecklist';
import { EnvTransferPlatforms } from './EnvTransferPlatforms';
import { EnvTransferPrompts } from './EnvTransferPrompts';
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
  const [platforms, setPlatforms] = useState<Set<string>>(new Set());
  const [prompts, setPrompts] = useState<Set<string>>(new Set());
  // Настройка шлюза не отмечена никогда по умолчанию: это порт слушателя ЭТОЙ
  // машины, и менять его архивом с чужой втихую панель не станет.
  const [gateway, setGateway] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setSelected(new Set(defaultSelection(plan.entries)));
    setPlatforms(new Set(defaultPlatformSelection(plan.platforms?.entries ?? [])));
    setPrompts(new Set(defaultPromptSelection(plan.prompts?.entries ?? [])));
    setGateway(false);
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

  const togglePlatform = (id: string): void => {
    setPlatforms((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePrompt = (id: string): void => {
    setPrompts((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
            disabled={selected.size === 0 && platforms.size === 0 && prompts.size === 0 && !gateway}
            onClick={() =>
              onApply({
                selection: [...selected],
                platforms: [...platforms],
                prompts: [...prompts],
                gateway,
              })
            }
          >
            {t('envTransfer.applySelected', {
              count: selected.size + platforms.size + prompts.size,
            })}
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
              title={entry.targetPath ?? serverFieldText(entry, 'problem')}
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

        {plan.platforms && (
          <EnvTransferPlatforms
            plan={plan.platforms}
            selected={platforms}
            onToggle={togglePlatform}
            gateway={gateway}
            onGateway={setGateway}
          />
        )}

        {plan.prompts && (
          <EnvTransferPrompts plan={plan.prompts} selected={prompts} onToggle={togglePrompt} />
        )}

        <EnvTransferChecklist items={plan.checklist} />
      </Stack>
    </Modal>
  );
}
