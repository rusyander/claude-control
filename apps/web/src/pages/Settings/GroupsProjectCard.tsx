import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupPermissionLevel } from '@agentdeck/contracts/split-groups';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { SelectField } from '@shared/ui/select-field';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useProjects } from '@entities/Project';
import { useSaveSplitSettings, useSplitDefaults, useSplitSettings } from '@entities/ProjectGit';
import { SplitSettings } from '@features/ProjectGit';
import { GroupPermissionRows } from './GroupPermissionRows';
import { projectRows, toggleProjectRow } from './model/groupRows';

/**
 * Правила групп одного проекта: доставка и число групп разом — тем же телом,
 * что и панель кнопки «До MR» в чате (одно место правды), и строки разрешений,
 * которые проект может переопределить. Непереопределённая строка помечена
 * «как в общих» и следует за общими правилами.
 */
export function GroupsProjectCard() {
  const { t } = useTranslation();
  const projects = useProjects();
  const [path, setPath] = useState('');
  const query = useSplitSettings(path || undefined);
  const defaults = useSplitDefaults().data?.defaults;
  const save = useSaveSplitSettings();
  const view = query.data;

  const options = [
    { value: '', label: t('settings.groups.projectPick') },
    ...(projects.data ?? [])
      .filter((project) => project.exists)
      .map((project) => ({ value: project.path, label: `${project.name} — ${project.path}` })),
  ];

  const putRows = (permissions: Record<string, GroupPermissionLevel> | null): void => {
    if (!view) return;
    save.mutate(
      {
        path,
        deliver: view.deliver,
        parallel: view.parallelAuto ? null : view.parallel,
        permissions,
      },
      {
        onSuccess: () => toast.success(t('settings.groups.saved')),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium">
            {t('settings.groups.projectTitle')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('settings.groups.projectHint')}
          </Typography>
        </Stack>

        <SelectField
          label={t('settings.groups.project')}
          value={path}
          onChange={setPath}
          options={options}
        />

        {path && query.isError && (
          <Typography variant="body-sm" color="danger">
            {toErrorMessage(query.error)}
          </Typography>
        )}

        {view && defaults && (
          <>
            <SplitSettings path={path} view={view} />

            <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
              <Typography variant="body-sm" weight="medium">
                {t('settings.groups.permissionsTitle')}
              </Typography>
              <Button
                variant="ghost"
                size="sm"
                disabled={save.isPending || view.permissionsOwn.length === 0}
                onClick={() => putRows(null)}
              >
                {t('settings.groups.resetToShared')}
              </Button>
            </Stack>
            <GroupPermissionRows
              rows={projectRows(view)}
              showOrigin
              disabled={save.isPending}
              onChange={(id, level) => putRows(toggleProjectRow(view, defaults, id, level))}
            />
          </>
        )}
      </Stack>
    </Card>
  );
}
