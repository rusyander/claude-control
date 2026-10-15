import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { deviceGpu, usableVramGb } from '@agentdeck/contracts/local-models';
import type { ModelBench } from '@agentdeck/contracts/local-models';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import {
  benchElsewhere,
  catalogRows,
  foreignInstalled,
  toGb,
  useAddCustomModel,
  useBenchModel,
  useCancelLocalJob,
  useConnectLocal,
  useImportModel,
  usePullModel,
  useRemoveModel,
  useSetModelChoice,
} from '@entities/LocalModels';
import { ModelRow } from '../ModelRow/ModelRow';
import { formatGb, quantTitle } from '../ModelSelects/optionText';
import styles from './CatalogCard.module.scss';
import type { CatalogCardProps, RemoveTarget } from './CatalogCard.types';
import { formatDate } from '../../../shared/lib/formatDate';

/** Строка «по чему считается, что влезает»: свободная видеопамять сейчас, процессорная — оперативная. */
function basisOf(
  info: CatalogCardProps['info'],
  availableGb: number,
  t: TFunction,
  locale: string,
): string {
  const gpu = deviceGpu(info.hardware, info.device);
  if (!gpu) return t('localModels.catalog.basisCpu', { available: formatGb(availableGb, locale) });
  const sizes = {
    available: formatGb(usableVramGb(gpu), locale),
    total: formatGb(gpu.vramGb, locale),
  };
  if (gpu.freeGb === undefined) return t('localModels.catalog.basisNoFree', sizes);
  return t('localModels.catalog.basis', { ...sizes, free: formatGb(gpu.freeGb, locale) });
}

function removeTitle(target: RemoveTarget, t: TFunction): string {
  if (target.quant) return t('localModels.catalog.files.removeTitle', { quant: target.quantTitle });
  return target.custom
    ? t('localModels.catalog.custom.removeCustomTitle')
    : t('localModels.catalog.removeTitle');
}

/** Что именно исчезнет и сколько места вернётся: у ссылки на файл Ollama — ничего, байты у Ollama. */
function removeText(target: RemoveTarget, t: TFunction, locale: string): string {
  const size = formatGb(toGb(target.freesBytes), locale);
  if (target.quant)
    return target.ollama
      ? t('localModels.catalog.files.removeOllamaText')
      : t('localModels.catalog.files.removeText', {
          quant: target.quantTitle,
          tag: target.tag,
          size,
        });
  if (target.custom)
    return t(
      target.count > 0
        ? 'localModels.catalog.custom.removeCustomText'
        : 'localModels.catalog.custom.removeCustomEmpty',
      { tag: target.tag, size },
    );
  return t('localModels.catalog.removeText', { tag: target.tag, count: target.count, size });
}

/** Каталог моделей для кода под эту машину плюс установленное помимо каталога. */
export function CatalogCard({ info }: CatalogCardProps) {
  const { t, i18n } = useTranslation();
  const pull = usePullModel();
  const importModel = useImportModel();
  const connect = useConnectLocal();
  const bench = useBenchModel();
  const remove = useRemoveModel();
  const cancel = useCancelLocalJob();
  const choose = useSetModelChoice();
  const addCustom = useAddCustomModel();
  const [toRemove, setToRemove] = useState<RemoveTarget | undefined>(undefined);
  const [repo, setRepo] = useState('');
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

  const basisText = basisOf(info, rows[0]?.choiceFit.availableGb ?? 0, t, i18n.language);

  const runBench = (tag: string): void =>
    bench.mutate(tag, {
      onSuccess: (result) =>
        toast.success(t('localModels.catalog.benched', { tag, value: result.tokensPerSec })),
    });
  const runConnect = (tag: string): void =>
    connect.mutate(tag, {
      onSuccess: () => toast.success(t('localModels.connect.connected', { model: tag })),
    });
  const submitCustom = (): void => {
    const input = repo.trim();
    if (input.length < 3) return;
    addCustom.mutate(input, {
      onSuccess: (model) => {
        toast.success(t('localModels.catalog.custom.added', { title: model.title }));
        setRepo('');
      },
    });
  };

  return (
    <Card padding="md" role="region" aria-label={t('localModels.catalog.title')}>
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm" as="h2">
          {t('localModels.catalog.title')}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {t('localModels.catalog.hint')}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {basisText}
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
              onPull={() =>
                pull.mutate({
                  tag: row.model.tag,
                  quant: row.choice.quant,
                  context: row.choice.context,
                })
              }
              onImport={() => importModel.mutate(row.model.tag)}
              onConnect={() => runConnect(row.model.tag)}
              onBench={() => runBench(row.model.tag)}
              onRemove={() =>
                setToRemove({
                  tag: row.model.tag,
                  freesBytes: row.downloaded.reduce((sum, file) => sum + file.freesBytes, 0),
                  count: row.downloaded.length,
                  custom: row.model.custom,
                  ollama: false,
                })
              }
              onRemoveFile={(file) =>
                setToRemove({
                  tag: row.model.tag,
                  quant: file.quant,
                  quantTitle: quantTitle(row.model, file.quant, t),
                  freesBytes: file.freesBytes,
                  count: 1,
                  custom: row.model.custom,
                  ollama: file.source === 'ollama',
                })
              }
              onCancel={(id) => cancel.mutate(id)}
              onChoose={(body) => choose.mutate({ tag: row.model.tag, ...body })}
            />
          ))}
        </div>
        <Typography variant="caption" color="muted">
          {t('localModels.catalog.checkedAt', {
            date: formatDate(info.catalog.checkedAt, i18n.language),
          })}
        </Typography>

        <form
          className={styles.customForm}
          onSubmit={(event) => {
            event.preventDefault();
            submitCustom();
          }}
          aria-label={t('localModels.catalog.custom.title')}
        >
          <Typography variant="heading-sm" as="h3">
            {t('localModels.catalog.custom.title')}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('localModels.catalog.custom.hint')}
          </Typography>
          <div className={styles.customRow}>
            <div className={styles.customField}>
              <TextField
                label={t('localModels.catalog.custom.label')}
                value={repo}
                onChange={setRepo}
                placeholder={t('localModels.catalog.custom.placeholder')}
                isMono
                disabled={addCustom.isPending}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              leftIcon={<Icon name="plus" />}
              isLoading={addCustom.isPending}
              disabled={repo.trim().length < 3}
            >
              {t('localModels.catalog.custom.add')}
            </Button>
          </div>
        </form>

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
                      t('localModels.catalog.size', {
                        size: formatGb(toGb(model.sizeBytes), i18n.language),
                      }),
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
                    onClick={() =>
                      setToRemove({
                        tag: model.tag,
                        freesBytes:
                          model.files?.reduce((sum, file) => sum + file.freesBytes, 0) ??
                          model.sizeBytes,
                        count: model.files?.length ?? 1,
                        custom: false,
                        ollama: false,
                      })
                    }
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
        title={toRemove ? removeTitle(toRemove, t) : ''}
        description={toRemove ? removeText(toRemove, t, i18n.language) : ''}
        confirmLabel={t('localModels.catalog.remove')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (!toRemove) return;
          const { tag, quant } = toRemove;
          remove.mutate(quant ? { tag, quant } : { tag }, {
            onSuccess: (result) => {
              const size = formatGb(toGb(result.freedBytes), i18n.language);
              toast.success(
                quant
                  ? t('localModels.catalog.files.removed', { quant: toRemove.quantTitle, size })
                  : t('localModels.catalog.removed', { size }),
              );
            },
            // Отказ (сервер держит файл, идёт загрузка) показывает общий тост ошибки; окно закрывается в обоих случаях.
            onSettled: () => setToRemove(undefined),
          });
        }}
      />
    </Card>
  );
}
