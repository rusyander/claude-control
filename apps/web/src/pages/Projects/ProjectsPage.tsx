import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@agentdeck/contracts';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { cn } from '@shared/lib/cn';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { FolderPicker } from '@features/FolderPicker';
import { useProjectRegistry, useAddProject, useRemoveProject } from '@entities/Project';
import { useSettings } from '@entities/AppConfig';
import { toast } from '@shared/lib/toast';
import { projectOnboardingText } from './projectOnboarding';
import { ProjectConfigPanel } from './ProjectConfigPanel';
import { ProviderProjectPanel } from './ProviderProjectPanel';
import styles from './ProjectsPage.module.scss';

/**
 * Проектный уровень конфигурации. Панель обычно ведёт пользовательский `~/.claude`,
 * а этот раздел — конфиги КОНКРЕТНОГО проекта: его файл инструкций, права в
 * `.claude/settings.json` и MCP-серверы в корневом `.mcp.json`. Слева — реестр
 * запомненных проектов, справа — конфиг выбранного.
 *
 * Раскладка собрана вокруг того, зачем сюда приходят: выбрать проект, прочитать
 * и поправить его инструкции, права и MCP, увидеть, что пришло из репозитория.
 * Страница занимает всю колонку — и ширину, и высоту: документ инструкций
 * дотягивается до низа окна, а реестр слева стоит на месте при прокрутке.
 *
 * Реестр проектов — раздел САМОЙ панели и от провайдера не зависит. А вот конфиг
 * выбранного проекта у каждого провайдера свой: Claude — своя панель
 * (инструкции/MCP/права/из проекта), прочие — универсальная (разделы решает
 * сервер, COMMON-2). До загрузки настроек считаем провайдера дефолтным (claude) —
 * как в остальных гейтах.
 */
export function ProjectsPage() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const providerId = settings?.provider ?? 'claude';
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const { data: projects = [], isLoading } = useProjectRegistry();
  const addProject = useAddProject();
  const removeProject = useRemoveProject();

  // Ссылка /projects?id=<id проекта> открывает его конфиг.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<Project>({
    items: projects,
    getId: (project) => project.id,
    onOpen: (project) => setSelectedId(project.id),
  });

  const select = (project: Project): void => {
    setSelectedId(project.id);
    writeUrl(project.id);
  };

  const handlePick = (path: string, name: string): void => {
    addProject.mutate(
      { path, name },
      {
        onSuccess: (project) => {
          setIsPickerOpen(false);
          select(project);
          // Папку e2e панель заводит или сверяет при добавлении — человек узнаёт
          // об этом здесь, а не из `git status`. Тост живёт дольше обычного:
          // его читают, а не просто замечают.
          const note = projectOnboardingText(project.e2e, t);
          if (note) {
            toast[note.tone](note.text, { title: t('testsE2e.onboard.title'), duration: 8000 });
          }
        },
      },
    );
  };

  const handleRemove = (project: Project): void => {
    removeProject.mutate(project.id, {
      onSuccess: () => {
        if (selectedId === project.id) {
          setSelectedId(undefined);
          writeUrl(undefined);
        }
      },
    });
  };

  const selected = projects.find((project) => project.id === selectedId);

  // Правая колонка: пока проект не выбран — приглашение выбрать, дальше конфиг
  // выбранного, своя панель у Claude и универсальная у прочих провайдеров.
  const renderDetails = (): ReactNode => {
    if (!selected) {
      return (
        <EmptyState
          icon="settings"
          title={t('projectConfig.pickTitle')}
          text={t('projectConfig.pickText')}
        />
      );
    }
    const panelProps = {
      project: selected,
      onRemove: () => handleRemove(selected),
      isRemoving: removeProject.isPending,
    };
    if (providerId === 'claude') return <ProjectConfigPanel {...panelProps} />;
    return <ProviderProjectPanel {...panelProps} />;
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('projectConfig.title')}
        // Тексты про CLAUDE.md/.claude уместны только у Claude — у остальных
        // провайдеров раздел ведёт ИХ проектные файлы (см. providerProject.*).
        subtitle={
          providerId === 'claude' ? t('projectsPage.subtitle') : t('providerProject.subtitle')
        }
        helpTopic="projects"
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size={24} />}
            onClick={() => setIsPickerOpen(true)}
          >
            {t('projectConfig.addProject')}
          </Button>
        }
      />

      <ExplainBox
        title={t('projectConfig.explainTitle')}
        text={providerId === 'claude' ? t('projectConfig.explain') : t('providerProject.explain')}
      />

      {isLoading && <SkeletonList rows={4} />}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon="folder"
          title={t('projectConfig.emptyTitle')}
          text={t('projectConfig.emptyText')}
        />
      )}

      {!isLoading && projects.length > 0 && (
        <div className={styles.layout}>
          <nav aria-label={t('projectsPage.registryLabel')} className={styles.registry}>
            <Typography variant="caption" color="subtle">
              {t('projectConfig.count', { count: projects.length })}
            </Typography>

            <ul className={styles.registryList}>
              {projects.map((project) => {
                const isActive = project.id === selectedId;
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={cn(styles.projectButton, isActive && styles.projectButtonActive)}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => select(project)}
                      title={project.path}
                    >
                      <Typography variant="body-sm" weight="medium" as="span" truncate>
                        {project.name}
                      </Typography>
                      <Typography
                        variant="mono"
                        color="subtle"
                        as="span"
                        truncate
                        className={styles.projectPath}
                      >
                        {project.path}
                      </Typography>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {renderDetails()}
        </div>
      )}

      <FolderPicker isOpen={isPickerOpen} onOpenChange={setIsPickerOpen} onPick={handlePick} />
    </div>
  );
}
