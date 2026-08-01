import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PermissionDecision } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { PERMISSION_DECISIONS } from '@entities/Permission';
import { useCreateProjectPermission, useUpdateProjectPermission } from '@entities/Project';
import type { ProjectPermissionFormProps } from './ProjectPermissionForm.types';

/**
 * Создание и правка правила доступа проекта (запись в `.claude/settings.json`
 * проекта). Право — имя инструмента, возможно с уточнением: `Bash(git push:*)`,
 * `Read`, `mcp__сервер__инструмент`.
 */
export function ProjectPermissionForm({
  isOpen,
  onOpenChange,
  projectId,
  rule,
}: ProjectPermissionFormProps) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState('');
  const [decision, setDecision] = useState<PermissionDecision>('ask');

  const create = useCreateProjectPermission(projectId);
  const update = useUpdateProjectPermission(projectId);

  useEffect(() => {
    if (!isOpen) return;
    setPattern(rule?.pattern ?? '');
    setDecision(rule?.decision ?? 'ask');
  }, [isOpen, rule]);

  const isPending = create.isPending || update.isPending;
  const canSave = pattern.trim().length > 0 && !isPending;

  const handleSave = (): void => {
    const draft = { pattern: pattern.trim(), decision, groupIds: [] };
    const onDone = { onSuccess: () => onOpenChange(false) };

    if (rule) update.mutate({ id: rule.id, draft }, onDone);
    else create.mutate(draft, onDone);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={rule ? t('common.edit') : t('projectConfig.addPermission')}
      description={t('common.needsRestart')}
      size="md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} isLoading={isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <TextField
          label={t('permissions.pattern')}
          value={pattern}
          onChange={setPattern}
          placeholder="Bash(git push:*)"
          hint={t('permissions.patternHint')}
          isMono
          autoFocus
        />

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium" as="span">
            {t('permissions.decision')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-2xs)" wrap>
            {PERMISSION_DECISIONS.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={decision === item ? 'primary' : 'secondary'}
                onClick={() => setDecision(item)}
              >
                {t(`permissions.${item}`)}
              </Button>
            ))}
          </Stack>
        </Stack>

        {(create.isError || update.isError) && (
          <Typography variant="body-sm" color="danger">
            {t('errors.saveFailed')}
          </Typography>
        )}
      </Stack>
    </Modal>
  );
}
