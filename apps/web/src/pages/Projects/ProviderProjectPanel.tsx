import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderProjectSection } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Card } from '@shared/ui/card';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderProject } from '@entities/Project';
import { ProviderProjectInstructionsTab } from './ProviderProjectInstructionsTab';
import { ProviderProjectInstructionsListTab } from './ProviderProjectInstructionsListTab';
import { ProviderProjectRulesTab } from './ProviderProjectRulesTab';
import { ProviderProjectMcpTab } from './ProviderProjectMcpTab';
import { ProviderProjectEnvTab } from './ProviderProjectEnvTab';
import { ProviderProjectPermissionsTab } from './ProviderProjectPermissionsTab';
import type { ProjectConfigPanelProps } from './ProjectConfigPanel.types';
import styles from './ProjectsPage.module.scss';

/**
 * Конфиг выбранного проекта у НЕ-Claude провайдера (COMMON-2).
 *
 * Какие разделы показывать, решает СЕРВЕР (`sections`), а не клиент: у Codex и
 * OpenCode это инструкции проекта + MCP-серверы, у Gemini к ним добавляются
 * переменные окружения (`.gemini/.env`) и права (`.gemini/settings.json`), у
 * Cursor — каталог правил `.cursor/rules/*.mdc` (CURSOR-1) плюс MCP. Раздел,
 * которого у провайдера нет, не показывается вовсе —
 * угадывать формат чужого конфига панель не станет. Ветка Claude — своя панель,
 * здесь её нет.
 */
export function ProviderProjectPanel({ project }: ProjectConfigPanelProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useProviderProject(project.id);
  const [tab, setTab] = useState<ProviderProjectSection | undefined>(undefined);

  if (isLoading) return <SkeletonList rows={4} />;

  // Провайдер проектного уровня не поддерживает (или каталог проекта исчез) —
  // честная заглушка вместо пустой панели.
  if (isError || !data || data.sections.length === 0) {
    return (
      <Card padding="md">
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Icon name="info" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerProject.unsupported')}
          </Typography>
        </Stack>
      </Card>
    );
  }

  const active = tab && data.sections.includes(tab) ? tab : data.sections[0]!;

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="folder" size={20} />
          <Typography variant="heading-sm" as="h2">
            {project.name}
          </Typography>
          <Badge tone="accent">{t('projectConfig.levelBadge')}</Badge>
          <Badge tone="neutral">{data.providerName}</Badge>
        </Stack>
        <Typography variant="mono" color="subtle" as="span" truncate>
          {project.path}
        </Typography>
      </Stack>

      <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.tabs}>
        {data.sections.map((section) => (
          <Button
            key={section}
            variant={active === section ? 'primary' : 'secondary'}
            onClick={() => setTab(section)}
          >
            {section === 'instructions'
              ? (data.instructionsFileName ?? t('providerProject.tab_instructions'))
              : section === 'instructionsList'
                ? t('providerProject.tab_instructionsList')
                : section === 'instructionsRules'
                  ? t('providerProject.tab_instructionsRules')
                  : section === 'mcp'
                    ? t('projectConfig.tab_mcp')
                    : section === 'env'
                      ? t('providerProject.tab_env')
                      : t('providerProject.tab_permissions')}
          </Button>
        ))}
      </Stack>

      {active === 'instructions' && <ProviderProjectInstructionsTab projectId={project.id} />}
      {active === 'instructionsList' && (
        <ProviderProjectInstructionsListTab projectId={project.id} />
      )}
      {active === 'instructionsRules' && <ProviderProjectRulesTab projectId={project.id} />}
      {active === 'mcp' && <ProviderProjectMcpTab projectId={project.id} />}
      {active === 'env' && <ProviderProjectEnvTab projectId={project.id} />}
      {active === 'permissions' && <ProviderProjectPermissionsTab projectId={project.id} />}
    </Stack>
  );
}
