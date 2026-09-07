import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { TabButton } from '@shared/ui/tab-button';
import { SelectField } from '@shared/ui/select-field';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { useStartManualRun } from '@entities/ProjectTest';
import { useTestsBoard } from '@features/ProjectTests';
import { TestRunnerModal } from '@features/TestRunner';
import { TestPlansPanel } from '@features/TestPlans';
import { IntegrationLinksBar } from '@features/IntegrationLinks';
import { useTestsProject } from '@entities/Project';
import { TestsLibraryTab } from './TestsLibraryTab';
import { TestsRunsTab } from './TestsRunsTab';
import { TestsReportTab } from './TestsReportTab';
import { TestsCoverageTab } from './TestsCoverageTab';
import styles from './TestsPage.module.scss';

/** Вкладки раздела в порядке рабочего дня: что проверяем → чем → что вышло. */
const TABS = ['library', 'plans', 'runs', 'report', 'coverage'] as const;
type TestsTab = (typeof TABS)[number];

/**
 * Рабочее место тестировщика.
 *
 * Раздел работает НАД проектом из реестра, а не над «текущим разговором»: тесты
 * лежат в файлах проекта, и открывать их через чат — это лишний шаг для того,
 * кто в чат сегодня вообще не заходит. Окно тестов из чата осталось и показывает
 * ту же библиотеку; здесь к ней добавлено всё, чего в модалку не помещалось:
 * планы, история и отчёт.
 *
 * Выбранная вкладка живёт в адресе (`?tab=`), чтобы ссылкой на отчёт можно было
 * поделиться, а выбранный проект — в памяти браузера: это предпочтение места
 * работы, а не часть ссылки.
 */
export function TestsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab, id } = useSearch({ strict: false }) as { tab?: string; id?: string };
  // Ссылка на конкретный кейс (`?id=<группа>:<кейс>` из общего поиска) всегда
  // ведёт в библиотеку: открыть кейс на вкладке отчёта не на чем.
  const chosen = id ? 'library' : tab;
  const active: TestsTab = TABS.includes(chosen as TestsTab) ? (chosen as TestsTab) : 'library';

  const project = useTestsProject();
  const projectPath = project.selected?.path;
  const board = useTestsBoard(projectPath, true);
  const startManual = useStartManualRun(projectPath);

  const [scope, setScope] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [isRunnerOpen, setRunnerOpen] = useState(false);

  const setTab = (next: TestsTab): void => {
    void navigate({ to: '.', search: { tab: next }, replace: true });
  };

  const openManual = async (payload: {
    planId?: string;
    groupId?: string;
    caseIds?: string[];
    environmentId?: string;
  }): Promise<void> => {
    await startManual.mutateAsync(payload);
    setRunnerOpen(true);
  };

  const startFromLibrary = (): void => {
    void openManual({
      groupId: board.activeId || undefined,
      caseIds:
        board.checked.length > 0
          ? board.checked
          : board.filters.filtered.map((item) => item.testCase.id),
      environmentId: environmentId || undefined,
    });
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('tests.title')}
        subtitle={t('tests.subtitle')}
        helpTopic="tests"
        actions={
          project.selected && (
            <Button
              variant="ghost"
              leftIcon={<Icon name="refresh" size={20} />}
              onClick={() => setRunnerOpen(true)}
            >
              {t('tests.runner.resume')}
            </Button>
          )
        }
      />

      {project.isLoading && <SkeletonList rows={3} />}

      {!project.isLoading && project.projects.length === 0 && (
        <EmptyState icon="folder" title={t('tests.noProjects')} text={t('tests.noProjectsHint')} />
      )}

      {project.projects.length > 0 && (
        <>
          <Stack direction="row" gap="var(--spacing-sm)" align="end" wrap>
            <SelectField
              label={t('tests.project')}
              value={project.selected?.id ?? ''}
              onChange={project.select}
              options={project.projects.map((item) => ({ value: item.id, label: item.name }))}
            />
            {project.selected && (
              <Typography variant="mono" color="subtle" as="span" truncate>
                {project.selected.path}
              </Typography>
            )}
            {/* Где лежат кейсы — первое, что спрашивает тестировщик: файлы
                ведёт и агент, и человек, и открывать их приходится руками. */}
            {project.selected && (
              <Typography variant="caption" color="subtle" as="span">
                {t('tests.dir', { dir: board.dir })}
              </Typography>
            )}
          </Stack>

          {/* Чем этот проект связан с внешним миром: куда заводить дефекты и
              где лежат требования. Стоит НАД вкладками — это свойство всей
              работы над проектом, а не одной её вкладки. */}
          <IntegrationLinksBar
            projectPath={projectPath}
            activeScope={board.activeId}
            scopes={board.groups.map((group) => ({ id: group.id, title: group.title }))}
          />

          <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
            {TABS.map((item) => (
              <TabButton key={item} isActive={item === active} onClick={() => setTab(item)}>
                {t(`tests.tab.${item}`)}
              </TabButton>
            ))}
          </Stack>

          {active === 'library' && (
            <TestsLibraryTab
              board={board}
              scope={scope}
              onScopeChange={setScope}
              environmentId={environmentId}
              onEnvironmentChange={setEnvironmentId}
              onStartManual={startFromLibrary}
              isStartingManual={startManual.isPending}
            />
          )}

          {active === 'plans' && (
            <TestPlansPanel
              projectPath={projectPath}
              groups={board.groups}
              views={board.views}
              environments={board.environments}
              onStartAgent={(planId, environment) =>
                board.start({ mode: 'run', planId, environmentId: environment, scope })
              }
              onStartManual={(planId, environment) =>
                void openManual({ planId, environmentId: environment })
              }
            />
          )}

          {active === 'runs' && (
            <TestsRunsTab
              projectPath={projectPath}
              groups={board.groups}
              isRunning={board.run?.status === 'running'}
            />
          )}

          {active === 'report' && <TestsReportTab projectPath={projectPath} />}

          {active === 'coverage' && <TestsCoverageTab projectPath={projectPath} />}
        </>
      )}

      <TestRunnerModal
        isOpen={isRunnerOpen}
        onOpenChange={setRunnerOpen}
        projectPath={projectPath}
        groups={board.groups}
        sharedSteps={board.sharedSteps}
      />
    </Stack>
  );
}
