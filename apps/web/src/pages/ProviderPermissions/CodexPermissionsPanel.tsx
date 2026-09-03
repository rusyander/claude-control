import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexApprovalPolicy, CodexSandboxMode } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SelectField } from '@shared/ui/select-field/select-field';
import type { CodexPermissionsPanelProps } from './ProviderPermissionsPanel.types';

/**
 * Права/аппрувы Codex. Форма из двух селектов — политика аппрувов
 * (`approval_policy`) и режим песочницы (`sandbox_mode`), скалярные ключи корня
 * config.toml. Под каждым значением — человекочитаемое пояснение; для
 * `danger-full-access` дано предупреждение о риске. Если формат файла не
 * распознан — раздел только для чтения.
 */
export function CodexPermissionsPanel({ data, save }: CodexPermissionsPanelProps) {
  const { t } = useTranslation();

  const [approvalPolicy, setApprovalPolicy] = useState<CodexApprovalPolicy>(data.approvalPolicy);
  const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>(data.sandboxMode);

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setApprovalPolicy(data.approvalPolicy);
    setSandboxMode(data.sandboxMode);
  }, [data]);

  const readOnly = data.readOnly;
  const dirty = approvalPolicy !== data.approvalPolicy || sandboxMode !== data.sandboxMode;
  const isDanger = sandboxMode === 'danger-full-access';

  const approvalOptions = data.approvalPolicies.map((value) => ({
    value,
    label: t(`providerPermissions.approval.${value}.label`),
  }));
  const sandboxOptions = data.sandboxModes.map((value) => ({
    value,
    label: t(`providerPermissions.sandbox.${value}.label`),
  }));

  const submit = (): void => {
    save.mutate({ approvalPolicy, sandboxMode });
  };

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('providerPermissions.title', { provider: data.providerName })}
        subtitle={t('providerPermissions.subtitle', { provider: data.providerName })}
        helpTopic="permissions"
        actions={
          !readOnly && (
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
        text={t('providerPermissions.explain', {
          provider: data.providerName,
          fileName: data.filePath,
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

      {data.usingDefaults && !readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="info" size={18} />
            <Typography variant="body-sm" color="muted">
              {t('providerPermissions.usingDefaults')}
            </Typography>
          </Stack>
        </Card>
      )}

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerPermissions.readOnly', { path: data.filePath })}
            </Typography>
          </Stack>
        </Card>
      )}

      <Card padding="md">
        <Stack gap="var(--spacing-lg)">
          <Stack gap="var(--spacing-2xs)">
            <SelectField
              label={t('providerPermissions.approval.label')}
              value={approvalPolicy}
              onChange={(value) => setApprovalPolicy(value as CodexApprovalPolicy)}
              options={approvalOptions}
            />
            <Typography variant="caption" color="subtle">
              {t(`providerPermissions.approval.${approvalPolicy}.description`)}
            </Typography>
          </Stack>

          <Stack gap="var(--spacing-2xs)">
            <SelectField
              label={t('providerPermissions.sandbox.label')}
              value={sandboxMode}
              onChange={(value) => setSandboxMode(value as CodexSandboxMode)}
              options={sandboxOptions}
            />
            <Typography variant="caption" color={isDanger ? 'danger' : 'subtle'}>
              {t(`providerPermissions.sandbox.${sandboxMode}.description`)}
            </Typography>
          </Stack>
        </Stack>
      </Card>
    </Stack>
  );
}
