import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { CompareSectionResult, ProviderMigrateRequest } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Card } from '@shared/ui/card';
import { PageHeader } from '@shared/ui/page-header';
import { SelectField } from '@shared/ui/select-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { toast } from '@shared/lib/toast';
import { useSettings } from '@entities/AppConfig';
import { useProviders } from '@entities/Provider';
import { useProviderCompare, useMigrateProvider } from '@entities/ProviderCompare';
import { WritePreviewDialog } from '@features/WritePreview';
import { CompareSection } from './CompareSection';
import styles from './ProviderComparePage.module.scss';

/**
 * Сравнение конфигураций двух провайдеров и перенос записей между ними
 * (IDEA-5 + IDEA-4).
 *
 * Раздел панель-level: он про ДВУХ провайдеров сразу, поэтому не гейтится
 * возможностями активного и не зависит от того, кто сейчас выбран. Слева по
 * умолчанию активный провайдер — с ним чаще всего и сравнивают.
 *
 * Перенос всегда идёт в два шага: сначала сервер считает дифф целевого файла на
 * временной копии, и только после подтверждения — настоящая запись. Один шаг
 * здесь был бы неуместной храбростью: пишем в файл чужого CLI, который человек
 * вёл руками.
 */
export function ProviderComparePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();

  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');

  const options = useMemo(
    () => (providers?.providers ?? []).map((item) => ({ value: item.id, label: item.name })),
    [providers],
  );

  // Стороны по умолчанию: активный провайдер и первый отличный от него. Сделано
  // через производное значение, а не эффектом: эффект успел бы отрисовать
  // страницу с пустыми сторонами и запросить сравнение «ничего с ничем».
  const leftId = left || settings?.provider || 'claude';
  const rightId = right || options.find((item) => item.value !== leftId)?.value || '';

  const compare = useProviderCompare(leftId, rightId);
  const migrate = useMigrateProvider();

  /** Что подтверждаем прямо сейчас: запрос переноса ждёт «Записать». */
  const [pending, setPending] = useState<ProviderMigrateRequest | undefined>(undefined);

  const swap = (): void => {
    setLeft(rightId);
    setRight(leftId);
  };

  const askMigrate = (request: ProviderMigrateRequest): void => {
    setPending(request);
    migrate.mutate({ ...request, mode: 'preview' });
  };

  const closeDialog = (): void => {
    setPending(undefined);
    migrate.reset();
  };

  const confirmMigrate = (): void => {
    if (!pending) return;
    const request = pending;
    setPending(undefined);

    migrate.mutate(
      { ...request, mode: 'apply' },
      {
        onSuccess: (result) => {
          migrate.reset();
          void queryClient.invalidateQueries({ queryKey: ['providers', 'compare'] });
          if (result.applied.length === 0) toast.info(t('providerCompare.migrateNothing'));
          else toast.success(t('providerCompare.migrateDone', { count: result.applied.length }));
          for (const skip of result.skipped) toast.info(`${skip.key}: ${skip.reason}`);
        },
        onError: () => {
          migrate.reset();
          toast.error(t('providerCompare.migrateError'));
        },
      },
    );
  };

  if (!settings || !providers) return <SkeletonList rows={4} />;

  return (
    <Stack gap="var(--spacing-md)">
      <PageHeader
        title={t('providerCompare.title')}
        subtitle={t('providerCompare.subtitle')}
        helpTopic="compare"
      />

      <Card padding="md">
        <Stack direction="row" gap="var(--spacing-sm)" align="end" className={styles.picker}>
          <SelectField
            label={t('providerCompare.left')}
            value={leftId}
            onChange={setLeft}
            options={options}
          />
          <Button variant="ghost" onClick={swap} aria-label={t('providerCompare.swap')}>
            <Icon name="swap" />
          </Button>
          <SelectField
            label={t('providerCompare.right')}
            value={rightId}
            onChange={setRight}
            options={options}
          />
        </Stack>
      </Card>

      {leftId === rightId ? (
        <EmptyState icon="swap" title={t('providerCompare.samePair')} />
      ) : compare.isLoading ? (
        <SkeletonList rows={4} />
      ) : compare.isError ? (
        <ExplainBox title={t('providerCompare.loadError')} text={t('providerCompare.loadErrorText')} />
      ) : (
        <Stack gap="var(--spacing-md)">
          {compare.data?.sections.map((section: CompareSectionResult) => (
            <CompareSection
              key={section.section}
              section={section}
              busy={migrate.isPending}
              onMigrate={askMigrate}
            />
          ))}
        </Stack>
      )}

      <WritePreviewDialog
        isOpen={pending !== undefined}
        isLoading={migrate.isPending}
        preview={migrate.data?.diff}
        error={migrate.isError}
        onCancel={closeDialog}
        onConfirm={confirmMigrate}
      />
    </Stack>
  );
}
