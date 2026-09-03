import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GeminiApprovalMode } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SelectField } from '@shared/ui/select-field/select-field';
import { TextField } from '@shared/ui/text-field';
import { listToText, textToList, sameList } from '@entities/ProviderPermissions';
import type { GeminiPermissionsPanelProps } from './ProviderPermissionsPanel.types';

/**
 * Права/аппрувы Gemini (GEMINI-2). Три ключа `settings.json`:
 * `general.defaultApprovalMode` (селект с пояснением риска у каждого значения) и
 * два списка инструментов — `coreTools` (белый) и `excludeTools` (чёрный,
 * приоритетнее белого). Списки правятся текстом «одно имя в строке».
 *
 * Режим `yolo` в форме отсутствует СОЗНАТЕЛЬНО: у Gemini он допустим только как
 * флаг командной строки, а в settings.json валит запуск CLI ошибкой — об этом
 * прямо сказано под селектом. Сервер такой запрос тоже отклоняет (400).
 */
export function GeminiPermissionsPanel({ data, save }: GeminiPermissionsPanelProps) {
  const { t } = useTranslation();

  const [approvalMode, setApprovalMode] = useState<GeminiApprovalMode>(data.approvalMode);
  const [coreToolsText, setCoreToolsText] = useState(listToText(data.coreTools));
  const [excludeToolsText, setExcludeToolsText] = useState(listToText(data.excludeTools));

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setApprovalMode(data.approvalMode);
    setCoreToolsText(listToText(data.coreTools));
    setExcludeToolsText(listToText(data.excludeTools));
  }, [data]);

  const readOnly = data.readOnly;
  const coreTools = textToList(coreToolsText);
  const excludeTools = textToList(excludeToolsText);
  const dirty =
    approvalMode !== data.approvalMode ||
    !sameList(coreTools, data.coreTools) ||
    !sameList(excludeTools, data.excludeTools);

  const modeOptions = data.approvalModes.map((value) => ({
    value,
    label: t(`providerPermissions.gemini.mode.${value}.label`),
  }));

  const submit = (): void => {
    save.mutate({ approvalMode, coreTools, excludeTools });
  };

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('providerPermissions.title', { provider: data.providerName })}
        subtitle={t('providerPermissions.gemini.subtitle', { provider: data.providerName })}
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
        text={t('providerPermissions.gemini.explain', {
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
              {t('providerPermissions.gemini.usingDefaults')}
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
              label={t('providerPermissions.gemini.mode.label')}
              value={approvalMode}
              onChange={(value) => setApprovalMode(value as GeminiApprovalMode)}
              options={modeOptions}
            />
            <Typography variant="caption" color="subtle">
              {t(`providerPermissions.gemini.mode.${approvalMode}.description`)}
            </Typography>
            <Typography variant="caption" color="warning">
              {t('providerPermissions.gemini.yoloNote')}
            </Typography>
          </Stack>

          <TextField
            label={t('providerPermissions.gemini.coreTools.label')}
            value={coreToolsText}
            onChange={setCoreToolsText}
            hint={t('providerPermissions.gemini.coreTools.hint')}
            placeholder={t('providerPermissions.gemini.toolsPlaceholder')}
            multiline
            rows={5}
            isMono
            disabled={readOnly}
          />

          <TextField
            label={t('providerPermissions.gemini.excludeTools.label')}
            value={excludeToolsText}
            onChange={setExcludeToolsText}
            hint={t('providerPermissions.gemini.excludeTools.hint')}
            placeholder={t('providerPermissions.gemini.toolsPlaceholder')}
            multiline
            rows={5}
            isMono
            disabled={readOnly}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
