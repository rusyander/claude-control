import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { OpencodePermissionsForm } from './OpencodePermissionsForm';
import type { OpencodePermissionsPanelProps } from './ProviderPermissionsPanel.types';

/**
 * Глобальный раздел прав OpenCode (OPENCODE-1): ключ `permission` файла
 * `~/.config/opencode/opencode.json`. Форма общая с табом проекта — здесь только
 * шапка страницы, пояснение и подсказка «CLI не обнаружен».
 */
export function OpencodePermissionsPanel({ data, save }: OpencodePermissionsPanelProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-lg)">
      <OpencodePermissionsForm
        data={data}
        onSave={(entries) => save.mutate({ entries })}
        header={({ dirty, submit }) => (
          <Stack gap="var(--spacing-lg)">
            <PageHeader
              title={t('providerPermissions.title', { provider: data.providerName })}
              subtitle={t('providerPermissions.opencode.subtitle', { provider: data.providerName })}
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
              text={t('providerPermissions.opencode.explain', {
                fileName: data.filePath,
                provider: data.providerName,
              })}
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
          </Stack>
        )}
      />
    </Stack>
  );
}
