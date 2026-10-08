import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderProjectSection } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Card } from '@shared/ui/card';
import { SkeletonList } from '@shared/ui/skeleton';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { useProviderProject } from '@entities/Project';
import { ProjectHeader } from '../ProjectHeader/ProjectHeader';
import { ProviderProjectInstructionsTab } from '../ProviderProjectInstructionsTab/ProviderProjectInstructionsTab';
import { ProviderProjectInstructionsListTab } from '../ProviderProjectInstructionsListTab/ProviderProjectInstructionsListTab';
import { ProviderProjectRulesTab } from '../ProviderProjectRulesTab/ProviderProjectRulesTab';
import { ProviderProjectMcpTab } from '../ProviderProjectMcpTab/ProviderProjectMcpTab';
import { ProviderProjectEnvTab } from '../ProviderProjectEnvTab/ProviderProjectEnvTab';
import { ProviderProjectPermissionsTab } from '../ProviderProjectPermissionsTab/ProviderProjectPermissionsTab';
import { ProviderProjectHooksTab } from '../ProviderProjectHooksTab/ProviderProjectHooksTab';
import { ProviderProjectPluginsTab } from '../ProviderProjectPluginsTab/ProviderProjectPluginsTab';
import { ProviderProjectSkillsTab } from '../ProviderProjectSkillsTab/ProviderProjectSkillsTab';
import type { ProjectConfigPanelProps } from '../ProjectConfigPanel/ProjectConfigPanel.types';
import styles from './ProviderProjectPanel.module.scss';

/**
 * Конфиг выбранного проекта у НЕ-Claude провайдера (COMMON-2).
 *
 * Какие разделы показывать, решает СЕРВЕР (`sections`), а не клиент: у Codex и
 * OpenCode это инструкции проекта + MCP-серверы, у Gemini к ним добавляются
 * переменные окружения (`.gemini/.env`) и права (`.gemini/settings.json`), у
 * Cursor — каталог правил `.cursor/rules/*.mdc` (CURSOR-1) плюс MCP. Раздел,
 * которого у провайдера нет, не показывается вовсе —
 * угадывать формат чужого конфига панель не станет. Шапка проекта и полоса
 * вкладок — те же, что у Claude: реестр общий, и страница не должна менять вид
 * от смены провайдера.
 */
export function ProviderProjectPanel({ project, onRemove, isRemoving }: ProjectConfigPanelProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useProviderProject(project.id);
  const [tab, setTab] = useState<ProviderProjectSection | undefined>(undefined);

  const header = (
    <ProjectHeader
      project={project}
      providerName={data?.providerName}
      onRemove={onRemove}
      isRemoving={isRemoving}
    />
  );

  if (isLoading) {
    return (
      <div className={styles.detail}>
        {header}
        <SkeletonList rows={4} />
      </div>
    );
  }

  // Провайдер проектного уровня не поддерживает (или каталог проекта исчез) —
  // честная заглушка вместо пустой панели.
  if (isError || !data || data.sections.length === 0) {
    return (
      <div className={styles.detail}>
        {header}
        <Card padding="md">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="info" size={18} />
            <Typography variant="body-sm" color="muted">
              {t('providerProject.unsupported')}
            </Typography>
          </Stack>
        </Card>
      </div>
    );
  }

  const active = tab && data.sections.includes(tab) ? tab : data.sections[0]!;

  /**
   * Подпись таба. Раньше это была лестница тернарников; с добавлением хуков и
   * плагинов она перестала читаться, поэтому — таблица. Имя файла инструкций
   * приходит с сервера и заменяет общую подпись, если оно известно.
   */
  const tabLabel = (section: ProviderProjectSection): string => {
    const labels: Record<ProviderProjectSection, string> = {
      instructions: data.instructionsFileName ?? t('providerProject.tab_instructions'),
      instructionsList: t('providerProject.tab_instructionsList'),
      instructionsRules: t(
        data.instructionsRulesFormat === 'cursor-mdc'
          ? 'providerProject.tab_instructionsRules'
          : 'providerProject.tab_instructionsRulesMd',
      ),
      mcp: t('projectsPage.tab.mcp'),
      env: t('providerProject.tab_env'),
      permissions: t('providerProject.tab_permissions'),
      hooks: t('providerProject.tab_hooks'),
      plugins: t('providerProject.tab_plugins'),
      skills: t('providerProject.tab_skills'),
    };
    return labels[section];
  };

  return (
    <div className={styles.detail}>
      {header}

      <PageTabs
        page="projects"
        label={t('projectsPage.tabsLabel')}
        tabs={data.sections.map((section) => ({ id: section, label: tabLabel(section) }))}
        active={active}
        onSelect={setTab}
      />

      <PageTabPanel page="projects" tab={active}>
        {active === 'instructions' && (
          <ProviderProjectInstructionsTab key={project.id} projectId={project.id} />
        )}
        {active === 'instructionsList' && (
          <ProviderProjectInstructionsListTab projectId={project.id} />
        )}
        {active === 'instructionsRules' && <ProviderProjectRulesTab projectId={project.id} />}
        {active === 'mcp' && <ProviderProjectMcpTab projectId={project.id} />}
        {active === 'env' && <ProviderProjectEnvTab projectId={project.id} />}
        {active === 'permissions' && <ProviderProjectPermissionsTab projectId={project.id} />}
        {active === 'hooks' && <ProviderProjectHooksTab projectId={project.id} />}
        {active === 'plugins' && <ProviderProjectPluginsTab projectId={project.id} />}
        {active === 'skills' && <ProviderProjectSkillsTab projectId={project.id} />}
      </PageTabPanel>
    </div>
  );
}
