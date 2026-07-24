import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GeminiApprovalMode } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { SelectField } from '@shared/ui/select-field/select-field';
import { TextField } from '@shared/ui/text-field';
import {
  useProviderProjectPermissions,
  useSaveProviderProjectPermissions,
} from '@entities/Project';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/** Список инструментов ↔ текст: одно имя в строке (пустые строки игнорируются). */
const listToText = (list: string[]): string => list.join('\n');
function textToList(text: string): string[] {
  const list: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (name && !list.includes(name)) list.push(name);
  }
  return list;
}
const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Права/аппрувы проекта у Gemini (GEMINI-2: `<проект>/.gemini/settings.json`).
 * Та же модель, что и в глобальном разделе: режим подтверждений плюс белый и
 * чёрный списки инструментов. Режима `yolo` в форме нет — в settings.json он
 * ломает запуск CLI (сервер такой запрос тоже отклоняет).
 */
export function ProviderProjectPermissionsTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useProviderProjectPermissions(projectId, true);
  const save = useSaveProviderProjectPermissions(projectId);

  const [approvalMode, setApprovalMode] = useState<GeminiApprovalMode>('default');
  const [coreToolsText, setCoreToolsText] = useState('');
  const [excludeToolsText, setExcludeToolsText] = useState('');

  useEffect(() => {
    if (!data) return;
    setApprovalMode(data.approvalMode);
    setCoreToolsText(listToText(data.coreTools));
    setExcludeToolsText(listToText(data.excludeTools));
  }, [data]);

  if (isLoading || !data) return <SkeletonList rows={3} />;

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

  return (
    <Stack gap="var(--spacing-sm)">
      <Stack direction="row" justify="between" align="center" wrap gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
          <Typography variant="caption" color="subtle">
            {t('providerProject.permissionsHint')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.filePath}
          </Typography>
        </Stack>
        {!readOnly && (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="check" size={20} />}
            onClick={() => save.mutate({ approvalMode, coreTools, excludeTools })}
            disabled={!dirty}
            isLoading={save.isPending}
          >
            {t('common.save')}
          </Button>
        )}
      </Stack>

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
            rows={4}
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
            rows={4}
            isMono
            disabled={readOnly}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
