import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import type { PageTabItem } from '@shared/ui/page-tabs';
import { useProjectLocal, useProjectMcp, useProjectPermissions } from '@entities/Project';
import { ProjectHeader } from './ProjectHeader';
import { ProjectRulesTab } from './ProjectRulesTab';
import { ProjectMcpTab } from './ProjectMcpTab';
import { ProjectPermissionsTab } from './ProjectPermissionsTab';
import { ProjectLocalTab } from './ProjectLocalTab';
import { useInstructionsDraft } from './model/useInstructionsDraft';
import type { ProjectConfigPanelProps, ProjectTab } from './ProjectConfigPanel.types';
import styles from './ProjectsPage.module.scss';

/**
 * Конфиг выбранного проекта у Claude: шапка проекта и четыре вкладки —
 * «Инструкции» (CLAUDE.md или AGENTS.md), «MCP-серверы» (.mcp.json), «Права»
 * (.claude/settings.json) и «Из проекта» — собственный .claude репозитория,
 * который панель только показывает.
 *
 * Полоса вкладок — сводка проекта: числа у вкладок видны сразу, пометка
 * «не сохранено» держится на «Инструкциях» с любой вкладки, а вкладка «только
 * чтение» отмечена замком. Внутри каждая вкладка первой строкой называет файл
 * и можно ли его здесь править.
 */
export function ProjectConfigPanel({ project, onRemove, isRemoving }: ProjectConfigPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ProjectTab>('rules');
  const draft = useInstructionsDraft(project.id);
  // Те же запросы, что у вкладок: кэш общий, числа на полосе — без лишних обращений.
  const mcp = useProjectMcp(project.id);
  const permissions = useProjectPermissions(project.id);
  const local = useProjectLocal(project.id);

  const localCounts = local.data
    ? {
        skills: local.data.skills.length,
        hooks: local.data.hooks.length,
        rules: local.data.rules.length,
      }
    : undefined;

  const tabs: PageTabItem<ProjectTab>[] = [
    {
      id: 'rules',
      label: t('projectsPage.tab.instructions'),
      note: draft.isDirty ? t('projectsPage.unsaved') : undefined,
    },
    { id: 'mcp', label: t('projectsPage.tab.mcp'), count: mcp.data?.length },
    {
      id: 'permissions',
      label: t('projectsPage.tab.permissions'),
      count: permissions.data?.length,
    },
    {
      id: 'local',
      label: t('projectsPage.tab.local'),
      icon: 'lock',
      count: localCounts ? localCounts.skills + localCounts.hooks + localCounts.rules : undefined,
      countHint: localCounts ? t('projectsPage.localCountHint', localCounts) : undefined,
    },
  ];

  return (
    <div className={styles.detail}>
      <ProjectHeader project={project} onRemove={onRemove} isRemoving={isRemoving} />

      <PageTabs
        page="projects"
        label={t('projectsPage.tabsLabel')}
        tabs={tabs}
        active={tab}
        onSelect={setTab}
      />

      <PageTabPanel page="projects" tab={tab}>
        {/* Документ пересоздаётся на смену проекта: режим «правка» и история
            отмен другого файла сюда не переезжают. */}
        {tab === 'rules' && <ProjectRulesTab key={project.id} draft={draft} />}
        {tab === 'mcp' && <ProjectMcpTab projectId={project.id} projectPath={project.path} />}
        {tab === 'permissions' && (
          <ProjectPermissionsTab projectId={project.id} projectPath={project.path} />
        )}
        {tab === 'local' && <ProjectLocalTab projectId={project.id} />}
      </PageTabPanel>
    </div>
  );
}
