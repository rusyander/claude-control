import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { FolderPicker } from '@features/FolderPicker';
import { DeleteButton } from '@features/EntityDelete';
import { useProjectRegistry, useAddProject, useRemoveProject } from '@entities/Project';
import { useSettings } from '@entities/AppConfig';
import { ProjectConfigPanel } from './ProjectConfigPanel';
import { ProviderProjectPanel } from './ProviderProjectPanel';
import styles from './ProjectsPage.module.scss';

/**
 * Проектный уровень конфигурации. Панель обычно ведёт пользовательский `~/.claude`,
 * а этот раздел — конфиги КОНКРЕТНОГО проекта: его CLAUDE.md, права и хуки в
 * `.claude/settings.json` и MCP-серверы в корневом `.mcp.json`. Слева — реестр
 * запомненных проектов, справа — конфиг выбранного.
 *
 * Реестр проектов — раздел САМОЙ панели и от провайдера не зависит. А вот конфиг
 * выбранного проекта у каждого провайдера свой: Claude — прежняя панель без
 * изменений (правила/MCP/права), прочие — универсальная (инструкции проекта +
 * MCP из его проектного файла, COMMON-2). До загрузки настроек считаем
 * провайдера дефолтным (claude) — как в остальных гейтах.
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
    if (providerId === 'claude') return <ProjectConfigPanel project={selected} />;
    return <ProviderProjectPanel project={selected} />;
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('projectConfig.title')}
        // Тексты про CLAUDE.md/.claude уместны только у Claude — у остальных
        // провайдеров раздел ведёт ИХ проектные файлы (см. providerProject.*).
        subtitle={
          providerId === 'claude' ? t('projectConfig.subtitle') : t('providerProject.subtitle')
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
          <Stack gap="var(--spacing-2xs)" className={styles.registry}>
            <Typography variant="caption" color="subtle">
              {t('projectConfig.count', { count: projects.length })}
            </Typography>

            {projects.map((project) => (
              <Stack key={project.id} direction="row" align="center" gap="var(--spacing-2xs)">
                <button
                  type="button"
                  className={[
                    styles.projectButton,
                    project.id === selectedId && styles.projectButtonActive,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => select(project)}
                  title={project.path}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Stack direction="row" align="center" gap="var(--spacing-2xs)">
                    <Icon name="folder" size={16} />
                    <Typography variant="body-sm" weight="medium" as="span" truncate>
                      {project.name}
                    </Typography>
                  </Stack>
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

                <DeleteButton
                  entityName={project.name}
                  description={t('projectConfig.removeDescription')}
                  onDelete={() => handleRemove(project)}
                  isPending={removeProject.isPending}
                />
              </Stack>
            ))}
          </Stack>

          {renderDetails()}
        </div>
      )}

      <FolderPicker isOpen={isPickerOpen} onOpenChange={setIsPickerOpen} onPick={handlePick} />
    </Stack>
  );
}
