import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { CursorPermissionsForm } from './CursorPermissionsForm';
import type { CursorPermissionsPanelProps } from './ProviderPermissionsPanel.types';

/**
 * Глобальный раздел прав Cursor: списки `permissions.allow` / `permissions.deny`
 * в `~/.cursor/cli-config.json`. Форма общая с табом проекта — здесь только шапка
 * страницы, пояснение и подсказки состояния.
 */
export function CursorPermissionsPanel({ data, save }: CursorPermissionsPanelProps) {
  const { t } = useTranslation();

  return (
    <CursorPermissionsForm
      data={data}
      onSave={(draft) => save.mutate(draft)}
      header={({ dirty, submit }) => (
        <Stack gap="var(--spacing-lg)">
          <PageHeader
            title={t('providerPermissions.title', { provider: data.providerName })}
            subtitle={t('providerPermissions.cursor.subtitle', { provider: data.providerName })}
            helpTopic="permissions"
            actions={
              !data.readOnly && (
                <Button
                  variant="primary"
                  leftIcon={<Icon name="check" size={24} />}
                  onClick={submit}
                  disabled={!dirty}
                  isLoading={save.isPending}
                >
                  {t('common.save')}
                </Button>
              )
            }
          />

          <ExplainBox
            title={t('providerPermissions.explainTitle')}
            text={t('providerPermissions.cursor.explain', { fileName: data.filePath })}
          />

          {!data.cliDetected && (
            <Card padding="sm">
              <Stack direction="row" align="center" gap="var(--spacing-xs)">
                <Icon name="info" size={18} />
                <Typography variant="body-sm" color="muted">
                  {t('providerPermissions.cliMissing', {
                    provider: data.providerName,
                    path: data.filePath,
                  })}
                </Typography>
              </Stack>
            </Card>
          )}

          {data.usingDefaults && !data.readOnly && (
            <Card padding="sm">
              <Stack direction="row" align="center" gap="var(--spacing-xs)">
                <Icon name="info" size={18} />
                <Typography variant="body-sm" color="muted">
                  {t('providerPermissions.cursor.usingDefaults')}
                </Typography>
              </Stack>
            </Card>
          )}

          {data.readOnly && (
            <Card padding="sm">
              <Stack direction="row" align="center" gap="var(--spacing-xs)">
                <Icon name="warning" size={18} />
                <Typography variant="body-sm" color="warning">
                  {t('providerPermissions.readOnly', { path: data.filePath })}
                </Typography>
              </Stack>
            </Card>
          )}
        </Stack>
      )}
    />
  );
}
