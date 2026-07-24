import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderEnvVar } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { DeleteButton } from '@features/EntityDelete';
import { useProviderProjectEnv, useSaveProviderProjectEnv } from '@entities/Project';
import { ProviderEnvForm } from '@pages/ProviderEnv/ProviderEnvForm';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/**
 * Переменные окружения проекта у активного провайдера (GEMINI-3:
 * `<проект>/.gemini/.env`). Тот же bulk-CRUD, что и в глобальном разделе: любое
 * изменение пересобирает полный набор и уходит одним PUT, сервер правит файл
 * построчно. Формат файла не распознан → раздел только для чтения (fail-closed).
 */
export function ProviderProjectEnvTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<ProviderEnvVar | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data, isLoading } = useProviderProjectEnv(projectId, true);
  const save = useSaveProviderProjectEnv(projectId);

  if (isLoading || !data) return <SkeletonList rows={3} />;

  const vars = data.vars;
  const readOnly = data.readOnly;

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };
  const openEdit = (item: ProviderEnvVar): void => {
    setEditing(item);
    setIsFormOpen(true);
  };

  const submit = (draft: ProviderEnvVar): void => {
    const next = editing
      ? vars.map((item) => (item.key === editing.key ? draft : item))
      : [...vars, draft];
    save.mutate(next, { onSuccess: () => setIsFormOpen(false) });
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <Stack direction="row" justify="between" align="center" wrap gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
          <Typography variant="caption" color="subtle">
            {t('providerProject.envHint')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.filePath}
          </Typography>
        </Stack>
        {!readOnly && (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="plus" size={20} />}
            onClick={openCreate}
          >
            {t('providerEnv.addVar')}
          </Button>
        )}
      </Stack>

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerEnv.readOnly', { path: data.filePath })}
            </Typography>
          </Stack>
        </Card>
      )}

      <Card padding="none">
        <Stack>
          {vars.map((item) => (
            <Stack
              key={item.key}
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-sm)"
              padding="var(--spacing-sm)"
            >
              <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                <Typography variant="mono" weight="medium" as="span">
                  {item.key}
                </Typography>
                <Typography variant="mono" color="subtle" as="span" truncate>
                  {item.value}
                </Typography>
              </Stack>

              {!readOnly && (
                <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="edit" size={24} />}
                    aria-label={`${t('common.edit')}: ${item.key}`}
                    onClick={() => openEdit(item)}
                  />
                  <DeleteButton
                    entityName={item.key}
                    description={t('providerEnv.deleteVar')}
                    onDelete={() => save.mutate(vars.filter((v) => v.key !== item.key))}
                    isPending={save.isPending}
                  />
                </Stack>
              )}
            </Stack>
          ))}
        </Stack>
      </Card>

      {vars.length === 0 && <Typography color="subtle">{t('providerProject.envEmpty')}</Typography>}

      <ProviderEnvForm
        isOpen={isFormOpen}
        onOpenChange={setIsFormOpen}
        envVar={editing}
        existingKeys={vars.map((v) => v.key)}
        onSubmit={submit}
        isPending={save.isPending}
      />
    </Stack>
  );
}
