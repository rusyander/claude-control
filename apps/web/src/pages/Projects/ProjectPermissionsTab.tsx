import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PermissionRule } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { SourceBadge } from '@shared/ui/source-badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { TruncatedText } from '@shared/ui/truncated-text';
import { DeleteButton } from '@features/EntityDelete';
import { DECISION_TONE } from '@entities/Permission';
import { useProjectPermissions, useDeleteProjectPermission } from '@entities/Project';
import { ProjectPermissionForm } from './ProjectPermissionForm';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/** Права проекта из его `.claude/settings.json` (+ settings.local.json). */
export function ProjectPermissionsTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<PermissionRule | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: rules = [], isLoading } = useProjectPermissions(projectId);
  const deleteRule = useDeleteProjectPermission(projectId);

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const openEdit = (rule: PermissionRule): void => {
    setEditing(rule);
    setIsFormOpen(true);
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <Stack direction="row" justify="between" align="center" wrap gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle">
          {t('projectConfig.permissionsHint')}
        </Typography>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Icon name="plus" size={20} />}
          onClick={openCreate}
        >
          {t('projectConfig.addPermission')}
        </Button>
      </Stack>

      {isLoading && <SkeletonList rows={3} />}

      {rules.map((rule) => (
        <Card key={rule.id} padding="sm">
          <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
            <TruncatedText text={rule.pattern} variant="mono" />

            <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
              <Badge tone={DECISION_TONE[rule.decision]} withDot>
                {t(`permissions.${rule.decision}`)}
              </Badge>
              <SourceBadge source={rule.source} />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="edit" size={24} />}
                aria-label={`${t('common.edit')}: ${rule.pattern}`}
                onClick={() => openEdit(rule)}
              />
              <DeleteButton
                entityName={rule.pattern}
                description={t('permissions.deletePermission', {
                  file: rule.source === 'settings-local' ? 'settings.local.json' : 'settings.json',
                })}
                onDelete={() => deleteRule.mutate(rule.id)}
                isPending={deleteRule.isPending}
              />
            </Stack>
          </Stack>
        </Card>
      ))}

      {!isLoading && rules.length === 0 && (
        <Typography color="subtle">{t('projectConfig.permissionsEmpty')}</Typography>
      )}

      <ProjectPermissionForm
        isOpen={isFormOpen}
        onOpenChange={setIsFormOpen}
        projectId={projectId}
        rule={editing}
      />
    </Stack>
  );
}
