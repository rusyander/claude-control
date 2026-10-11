import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { useLocalModels, useRefreshHardware } from '@entities/LocalModels';
import { LocalModelHint } from '@features/LocalModelHint';
import { HardwareCard } from '../HardwareCard/HardwareCard';
import { RuntimeCard } from '../RuntimeCard/RuntimeCard';
import { CatalogCard } from '../CatalogCard/CatalogCard';
import { AgentsCard } from '../AgentsCard/AgentsCard';
import { LOCAL_MODELS_TABS, LOCAL_MODELS_TAB_ICONS } from '../model/tabs';
import styles from './LocalModelsPage.module.scss';

/**
 * «Локальные модели»: видеокарта → что на ней пойдёт → скачать одной кнопкой →
 * замерить → отдать агентам. Всё, что раньше человек ставил и прописывал руками
 * (сервер моделей, переменные, контекст, адрес для Claude Code), панель делает
 * сама и показывает, где что лежит.
 *
 * Этапы разложены по вкладкам в порядке этого пути. Подсказка «Скачать и
 * подключить» стоит над полосой: она ведёт через все три этапа сразу и нужна с
 * любой вкладки.
 */
export function LocalModelsPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useLocalModels();
  const refresh = useRefreshHardware();
  const { active: activeTab, select: selectTab } = usePageTab('localModels', LOCAL_MODELS_TABS);

  const tabs = LOCAL_MODELS_TABS.map((id) => ({
    id,
    label: t(`pageTabs.localModels.tab.${id}`),
    icon: LOCAL_MODELS_TAB_ICONS[id],
  }));

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
          <PageTabs
            page="localModels"
            label={t('pageTabs.localModels.tabsLabel')}
            tabs={tabs}
            active={activeTab}
            onSelect={selectTab}
          />
          <PageTabPanel
            page="localModels"
            tab={activeTab}
            hint={t(`pageTabs.localModels.hint.${activeTab}`)}
          >
            {activeTab === 'hardware' && (
              <div className={styles.grid}>
                <HardwareCard
                  hardware={data.hardware}
                  isRefreshing={refresh.isPending}
                  onRefresh={() => refresh.mutate()}
                />
                <RuntimeCard info={data} />
              </div>
            )}
            {activeTab === 'models' && (
              <>
                <CatalogCard info={data} />
                <ExplainBox
                  title={t('localModels.datasets.title')}
                  text={t('localModels.datasets.text')}
                />
              </>
            )}
            {activeTab === 'agents' && <AgentsCard info={data} />}
          </PageTabPanel>
        </>
      ) : null}
    </Stack>
  );
}
