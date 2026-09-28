import { useEffect, useState } from 'react';
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
import { LoadErrorCard } from '@shared/ui/load-error';
import { useManualSession, useStartManualRun } from '@entities/ProjectTest';
import { TestSettingsModal, useTestsBoard } from '@features/ProjectTests';
import { TestRunnerModal } from '@features/TestRunner';
import { TestPlansPanel } from '@features/TestPlans';
import { IntegrationLinksBar } from '@features/IntegrationLinks';
import { projectByPath, useTestsProject } from '@entities/Project';
import { TestsLibraryTab } from './TestsLibraryTab';
import { TestsRunsTab } from './TestsRunsTab';
import { TestsReportTab } from './TestsReportTab';
import { TestsCoverageTab } from './TestsCoverageTab';
import { askedProjectMissing, askedProjectPending, testsProjectState } from './model/projectState';
import { runnerStartOffer } from './model/runnerStart';
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
  const {
    tab,
    id,
    run: askedRun,
    project: askedPath,
  } = useSearch({ strict: false }) as {
    tab?: string;
    id?: string;
    run?: string;
    project?: string;
  };
  // Ссылка на конкретный кейс (`?id=<группа>:<кейс>` из общего поиска) всегда
  // ведёт в библиотеку: открыть кейс на вкладке отчёта не на чем.
  const chosen = id ? 'library' : tab;
  const active: TestsTab = TABS.includes(chosen as TestsTab) ? (chosen as TestsTab) : 'library';

  const project = useTestsProject();
  const projectPath = project.selected?.path;

  // Агент панели открывает раздел на том проекте, с которым работал
  // (`?project=<каталог>`): выбор проекта живёт в памяти браузера, и без этого
  // человек смотрел бы на тесты другого проекта. Выбрали — параметр убираем,
  // дальше это обычный выбор, который человек может сменить.
  //
  // Каталог, которого панель не знает, раньше молча подменялся другим проектом:
  // человек смотрел не на те тесты и не знал об этом. Теперь раздел называет
  // промах строкой над выбором проекта — до тех пор, пока её не закроют.
  const { projects, select } = project;
  const [missingPath, setMissingPath] = useState('');
  useEffect(() => {
    if (!askedPath) return;
    const found = projectByPath(projects, askedPath);
    const isMissing = askedProjectMissing(projects, askedPath, project);
    if (!found && !isMissing) return;
    if (found) select(found.id);
    else setMissingPath(askedPath);
    void navigate({
      to: '.',
      search: {
        ...(tab ? { tab } : {}),
        ...(id ? { id } : {}),
        ...(askedRun ? { run: askedRun } : {}),
      },
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedPath, projects, project.isLoading, project.isError]);
  // Реестр упал, а каталога из ссылки нет среди вкладок: решить нельзя, и
  // открытый проект — не тот, о котором просили. Строка держится, пока реестр
  // не загрузится; тогда эффект выше найдёт проект или назовёт его пропавшим.
  const isAskedUnchecked =
    project.isError && askedProjectPending(projects, askedPath, project) && !missingPath;
  const projectState = testsProjectState({
    isLoading: project.isLoading,
    isError: project.isError,
    count: project.projects.length,
  });
  const board = useTestsBoard(projectPath, true);
  const startManual = useStartManualRun(projectPath);
  // «Вернуться к проходу» обещает проход, к которому есть куда вернуться; без
  // сессии та же кнопка открывает пустой пульт — и называется по нему.
  const manual = useManualSession(projectPath);
  const hasManualSession = Boolean(manual.data && !manual.data.finishedAt);

  const [scope, setScope] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [isRunnerOpen, setRunnerOpen] = useState(false);
  const [isSettingsOpen, setSettingsOpen] = useState(false);

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

  // Пустой пульт — не тупик: он начинает проход тем же набором, что кнопка
  // «Пройти руками» в библиотеке, или ведёт к тест-планам.
  const startOffer = runnerStartOffer({
    groups: board.groups,
    activeId: board.activeId,
    checked: board.checked,
    visible: board.filters.filtered.length,
  });
  const runnerEmptyActions = (
    <Stack direction="row" gap="var(--spacing-sm)" align="center" wrap justify="center">
      {startOffer && (
        <Button
          variant="primary"
          leftIcon={<Icon name="check" size={20} />}
          isLoading={startManual.isPending}
          onClick={startFromLibrary}
        >
          {t('tests.runner.startGroup', {
            group: startOffer.groupTitle,
            count: startOffer.count,
          })}
        </Button>
      )}
      <Button
        variant="secondary"
        onClick={() => {
          setRunnerOpen(false);
          setTab('plans');
        }}
      >
        {t('tests.runner.toPlans')}
      </Button>
    </Stack>
  );

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
              {t(hasManualSession ? 'tests.runner.resume' : 'tests.runner.title')}
            </Button>
          )
        }
      />

      {projectState === 'loading' && <SkeletonList rows={3} />}

      {projectState === 'error' && (
        <LoadErrorCard
          title={t('tests.registryError')}
          text={t('tests.registryErrorText')}
          onRetry={project.retry}
        />
      )}

      {projectState === 'empty' && (
        <EmptyState icon="folder" title={t('tests.noProjects')} text={t('tests.noProjectsHint')} />
      )}

      {/* Реестр упал, но открытые вкладки проектов есть: работать по ним можно,
          только список неполный — и об этом надо сказать, а не молчать. */}
      {projectState === 'ready' && project.isError && (
        <Stack direction="row" gap="var(--spacing-sm)" align="center" wrap role="status">
          <Typography variant="body-sm" color="warning">
            {t('tests.registryPartial')}
          </Typography>
          <Button variant="ghost" size="sm" onClick={project.retry}>
            {t('common.retry')}
          </Button>
        </Stack>
      )}

      {isAskedUnchecked && askedPath && project.selected && (
        <Typography variant="body-sm" color="warning" role="status">
          {t('tests.projectUnchecked', { path: askedPath, name: project.selected.name })}
        </Typography>
      )}

      {missingPath && (
        <Stack direction="row" gap="var(--spacing-sm)" align="center" wrap role="status">
          <Typography variant="body-sm" color="warning">
            {t('tests.projectMissing', {
              path: missingPath,
              name: project.selected?.name ?? '—',
            })}
          </Typography>
          <Button variant="ghost" size="sm" onClick={() => setMissingPath('')}>
            {t('common.close')}
          </Button>
        </Stack>
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
            {/* Путь и каталог кейсов — столбиком высотой с поле выбора: так
                они стоят на одной линии с ним, а не висят ниже середины.
                Где лежат кейсы — первое, что спрашивает тестировщик: файлы
                ведёт и агент, и человек, и открывать их приходится руками. */}
            {project.selected && (
              <Stack gap="0" minWidth={0} className={styles.projectMeta}>
                <Typography variant="mono" color="subtle" as="span" truncate>
                  {project.selected.path}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.dir', { dir: board.dir })}
                </Typography>
              </Stack>
            )}
            {/* Настройки набора стоят рядом с выбором проекта, а не во вкладках:
                окружения, общие шаги и свои поля — свойства ВСЕГО набора, и
                заводят их до того, как появляется первая вкладка. */}
            {project.selected && (
              <Button
                variant="ghost"
                leftIcon={<Icon name="settings" size={20} />}
                onClick={() => setSettingsOpen(true)}
              >
                {t('tests.settings.open')}
              </Button>
            )}
            {/* Чем этот проект связан с внешним миром: куда заводить дефекты и
                где лежат требования. Стоит НАД вкладками — это свойство всей
                работы над проектом, а не одной её вкладки, — и в одной строке
                с выбором проекта: отдельными строками шапка съедала высоту,
                нужную списку кейсов. */}
            <IntegrationLinksBar
              projectPath={projectPath}
              activeScope={board.activeId}
              scopes={board.groups.map((group) => ({ id: group.id, title: group.title }))}
            />
          </Stack>

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
              openRunId={askedRun}
              groups={board.groups}
              isRunning={board.run?.status === 'running'}
            />
          )}

          {active === 'report' && <TestsReportTab projectPath={projectPath} />}

          {active === 'coverage' && <TestsCoverageTab projectPath={projectPath} />}
        </>
      )}

      <TestSettingsModal isOpen={isSettingsOpen} onOpenChange={setSettingsOpen} board={board} />

      <TestRunnerModal
        isOpen={isRunnerOpen}
        onOpenChange={setRunnerOpen}
        projectPath={projectPath}
        groups={board.groups}
        sharedSteps={board.sharedSteps}
        emptyActions={runnerEmptyActions}
      />
    </Stack>
  );
}
