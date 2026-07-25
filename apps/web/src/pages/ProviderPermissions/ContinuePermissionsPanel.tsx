import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { ContinuePermissionsForm } from './ContinuePermissionsForm';
import type { ContinuePermissionsPanelProps } from './ProviderPermissionsPanel.types';

/**
 * Глобальный раздел прав Continue: списки `allow` / `ask` / `exclude` в отдельном
 * файле `~/.continue/permissions.yaml`. Форма общая с табом проекта — здесь
 * только шапка страницы, пояснение и подсказки состояния.
 */
export function ContinuePermissionsPanel({ data, save }: ContinuePermissionsPanelProps) {
  const { t } = useTranslation();

  return (
    <ContinuePermissionsForm
      data={data}
      onSave={(draft) => save.mutate(draft)}
      header={({ dirty, submit }) => (
        <Stack gap="var(--spacing-lg)">
          <PageHeader
            title={t('providerPermissions.title', { provider: data.providerName })}
            subtitle={t('providerPermissions.continue.subtitle', { provider: data.providerName })}
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
            text={t('providerPermissions.continue.explain', { fileName: data.filePath })}
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
                  {t('providerPermissions.continue.usingDefaults')}
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
