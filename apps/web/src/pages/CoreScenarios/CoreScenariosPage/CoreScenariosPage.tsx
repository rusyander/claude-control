import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CoreHopsNotice, coreRefusalOf } from '@entities/CoreTask';
import { NewScenarioForm, parseRef, refText, useScenarioList } from '@features/ScenarioEditor';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { EmptyState } from '@shared/ui/empty-state';
import { LoadErrorCard } from '@shared/ui/load-error';
import { PageHeader } from '@shared/ui/page-header';
import { PageTabPanel, PageTabs } from '@shared/ui/page-tabs';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { LibraryTab } from '../LibraryTab/LibraryTab';
import { TaskTab } from '../TaskTab/TaskTab';
import { CORE_SCENARIOS_PAGE, CORE_SCENARIOS_TABS, type CoreScenariosTab } from '../model/tabs';

/**
 * Сценарии ядра `/core/scenarios` (этап 9): библиотека (пресеты и версии человека на чтение),
 * новый сценарий (с нуля или на основе — запись однократна, строгое действие человека) и правка
 * сценария идущей задачи. `?tab=` — вкладка, `?id=` — её предмет: ссылка сценария `id@v` на
 * библиотеке и основе нового, id задачи на правке.
 */
export function CoreScenariosPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { id?: unknown };
  const { active, select } = usePageTab(CORE_SCENARIOS_PAGE, CORE_SCENARIOS_TABS);
  const list = useScenarioList();
  const refusal = coreRefusalOf(list.error);
  const id = typeof search.id === 'string' && search.id ? search.id : undefined;
  const open = (tab: CoreScenariosTab, next: string): void =>
    void navigate({ to: '.', search: { tab, id: next }, replace: true });

  const tabs = CORE_SCENARIOS_TABS.map((tab) => ({
    id: tab,
    label: t(`coreScenario.tabs.${tab}`),
  }));
  const listing = list.data;
  const all = listing ? [...listing.presets, ...listing.library] : [];
  const baseRef = active === 'new' ? parseRef(id) : undefined;
  const base = baseRef ? all.find((s) => refText(s) === refText(baseRef)) : undefined;

  return (
    <Stack gap="var(--spacing-lg)" data-core-scenarios-page>
      <PageHeader
        title={t('coreScenario.title')}
        subtitle={t('coreScenario.subtitle')}
        helpTopic="core"
      />
      <CoreHopsNotice />
      {list.isLoading && <SkeletonList rows={4} />}
      {refusal && (
        <div data-core-refusal={refusal}>
          <EmptyState
            icon="warning"
            title={t(`coreTimeline.refusal.${refusal}.title`)}
            text={t(`coreTimeline.refusal.${refusal}.text`)}
          />
        </div>
      )}
      {list.isError && !refusal && (
        <LoadErrorCard title={t('coreScenario.loadError')} onRetry={() => void list.refetch()} />
      )}
      {listing && (
        <>
          <PageTabs
            page={CORE_SCENARIOS_PAGE}
            label={t('coreScenario.tabs.label')}
            tabs={tabs}
            active={active}
            onSelect={select}
          />
          <PageTabPanel
            page={CORE_SCENARIOS_PAGE}
            tab={active}
            hint={t(`coreScenario.tabs.hint.${active}`)}
          >
            {active === 'library' && (
              <LibraryTab
                listing={listing}
                selected={id}
                onSelect={(ref) => open('library', ref)}
                onBase={(ref) => open('new', ref)}
              />
            )}
            {active === 'new' && (
              // Новая основа — новый черновик: ключ по основе пересоздаёт форму.
              <NewScenarioForm
                key={base ? refText(base) : 'blank'}
                library={listing.library}
                base={base}
              />
            )}
            {active === 'task' && (
              <TaskTab
                library={listing.library}
                taskId={id}
                onPick={(taskId) => open('task', taskId)}
              />
            )}
          </PageTabPanel>
        </>
      )}
    </Stack>
  );
}
