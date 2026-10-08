import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstalledModel, ModelBench } from '@agentdeck/contracts/local-models';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import {
  benchElsewhere,
  catalogRows,
  foreignInstalled,
  toGb,
  useBenchModel,
  useCancelLocalJob,
  useConnectLocal,
  useImportModel,
  usePullModel,
  useRemoveModel,
} from '@entities/LocalModels';
import { ModelRow } from '../ModelRow/ModelRow';
import styles from './CatalogCard.module.scss';
import type { CatalogCardProps } from './CatalogCard.types';
import { formatDate } from '../../../shared/lib/formatDate';

/** Каталог моделей для кода под эту машину плюс установленное помимо каталога. */
export function CatalogCard({ info }: CatalogCardProps) {
  const { t, i18n } = useTranslation();
  const pull = usePullModel();
  const importModel = useImportModel();
  const connect = useConnectLocal();
  const bench = useBenchModel();
  const remove = useRemoveModel();
  const cancel = useCancelLocalJob();
  const [toRemove, setToRemove] = useState<InstalledModel | undefined>(undefined);
  const rows = catalogRows(info);
  const measuredText = (bench: ModelBench): string => {
    const where = benchElsewhere(bench, info.device);
    return where
      ? t('localModels.catalog.measuredOn', {
          value: bench.tokensPerSec,
          where: t(`localModels.catalog.measuredWhere.${where}`),
        })
      : t('localModels.catalog.measured', { value: bench.tokensPerSec });
  };
  const foreign = foreignInstalled(info);
  const canRun = info.runtime.source !== 'none';
  const inUse = (tag: string): boolean => info.connect.active && info.connect.model === tag;

  const runBench = (tag: string): void =>
    bench.mutate(tag, {
      onSuccess: (result) =>
        toast.success(t('localModels.catalog.benched', { tag, value: result.tokensPerSec })),
    });
  const runConnect = (tag: string): void =>
    connect.mutate(tag, {
      onSuccess: () => toast.success(t('localModels.connect.connected', { model: tag })),
    });

  return (
    <Card padding="md" role="region" aria-label={t('localModels.catalog.title')}>
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm" as="h2">
          {t('localModels.catalog.title')}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {t('localModels.catalog.hint')}
        </Typography>
        <div className={styles.modelList}>
          {rows.map((row) => (
            <ModelRow
              key={row.model.tag}
              row={row}
              inUse={inUse(row.model.tag)}
              serverReady={canRun}
              busy={{
                pull: pull.isPending && pull.variables.tag === row.model.tag,
                bench: bench.isPending && bench.variables === row.model.tag,
                connect: connect.isPending && connect.variables === row.model.tag,
              }}
              onPull={() => pull.mutate({ tag: row.model.tag })}
              onImport={() => importModel.mutate(row.model.tag)}
              onConnect={() => runConnect(row.model.tag)}
              onBench={() => runBench(row.model.tag)}
              onRemove={() => row.installed && setToRemove(row.installed)}
              onCancel={(id) => cancel.mutate(id)}
            />
          ))}
        </div>
        <Typography variant="caption" color="muted">
          {t('localModels.catalog.checkedAt', {
            date: formatDate(info.catalog.checkedAt, i18n.language),
          })}
        </Typography>

        {foreign.length > 0 ? (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="heading-sm" as="h3">
              {t('localModels.catalog.foreignTitle')}
            </Typography>
            <Typography variant="caption" color="muted">
              {t('localModels.catalog.foreignHint')}
            </Typography>
            {foreign.map((model) => (
              <div key={model.tag} className={styles.modelRow}>
                <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
                  <Typography variant="mono">{model.tag}</Typography>
                  <Typography variant="caption" color="muted">
                    {[
                      t('localModels.catalog.size', { size: toGb(model.sizeBytes) }),
                      model.bench ? measuredText(model.bench) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                </Stack>
                <Stack direction="row" gap="var(--spacing-xs)">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!canRun}
                    isLoading={bench.isPending && bench.variables === model.tag}
                    onClick={() => runBench(model.tag)}
                  >
                    {t('localModels.catalog.bench')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="trash" />}
                    aria-label={t('localModels.catalog.remove')}
                    onClick={() => setToRemove(model)}
                  />
                </Stack>
              </div>
            ))}
          </Stack>
        ) : null}
      </Stack>
      <ConfirmDialog
        isOpen={Boolean(toRemove)}
        onOpenChange={(open) => {
          if (!open) setToRemove(undefined);
        }}
        title={t('localModels.catalog.removeTitle')}
        description={t('localModels.catalog.removeText', {
          tag: toRemove?.tag ?? '',
          size: toRemove ? toGb(toRemove.sizeBytes) : 0,
        })}
        confirmLabel={t('localModels.catalog.remove')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (!toRemove) return;
          remove.mutate(toRemove.tag, {
            onSuccess: () => {
              toast.success(t('localModels.catalog.removed'));
              setToRemove(undefined);
            },
          });
        }}
      />
    </Card>
  );
}
