import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { useLocalModels, useRefreshHardware } from '@entities/LocalModels';
import { LocalModelHint } from '@features/LocalModelHint';
import { HardwareCard } from '../HardwareCard/HardwareCard';
import { RuntimeCard } from '../RuntimeCard/RuntimeCard';
import { CatalogCard } from '../CatalogCard/CatalogCard';
import { AgentsCard } from '../AgentsCard/AgentsCard';
import styles from './LocalModelsPage.module.scss';

/**
 * «Локальные модели»: видеокарта → что на ней пойдёт → скачать одной кнопкой →
 * замерить → отдать агентам. Всё, что раньше человек ставил и прописывал руками
 * (сервер моделей, переменные, контекст, адрес для Claude Code), панель делает
 * сама и показывает, где что лежит.
 */
export function LocalModelsPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useLocalModels();
  const refresh = useRefreshHardware();

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('localModels.title')}
        subtitle={t('localModels.subtitle')}
        helpTopic="localModels"
      />
      {isLoading ? <SkeletonList /> : null}
      {isError ? (
        <LoadErrorCard title={t('localModels.loadError')} onRetry={() => void refetch()} />
      ) : null}
      {data ? (
        <>
          <LocalModelHint />
          <div className={styles.grid}>
            <HardwareCard
              hardware={data.hardware}
              isRefreshing={refresh.isPending}
              onRefresh={() => refresh.mutate()}
            />
            <RuntimeCard info={data} />
          </div>
          <CatalogCard info={data} />
          <AgentsCard info={data} />
          <ExplainBox
            title={t('localModels.datasets.title')}
            text={t('localModels.datasets.text')}
          />
        </>
      ) : null}
    </Stack>
  );
}
