import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderHookRule } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { ExplainBox } from '@shared/ui/explain-box';
import { useSaveProviderHooks } from '@entities/ProviderHooks';
import { nextRowId, stableDraft } from './ProviderHooks.lib';
import { toDraft, toRow } from './ProviderHookRulesEditor.lib';
import type { ProviderHookRulesEditorProps, RuleRow } from './ProviderHookRulesEditor.types';

/**
 * Хуки в модели «правило на событие» (QWEN-1, KIMI-1).
 *
 * Одно правило = событие + необязательный матчер + команда оболочки +
 * необязательный таймаут. Хранилища два и они разные (`hooks` в settings.json у
 * Qwen, `[[hooks]]` в config.toml у Kimi), но форма редактора одна: сервер
 * присылает словарь событий, границы и ЕДИНИЦУ таймаута — у Qwen это
 * миллисекунды, у Kimi секунды, и подпись поля берётся оттуда, а не угадывается.
 *
 * Матчер показывается только у событий, которые его поддерживают: у остальных
 * CLI его молча проигнорирует, а пользователь будет думать, что фильтр работает.
 *
 * Событие, форму которого панель не разобрала, редактировать нельзя — оно
 * показано отдельной карточкой только для чтения и остаётся в файле нетронутым.
 */
export function ProviderHookRulesEditor({ data, projectId }: ProviderHookRulesEditorProps) {
  const { t } = useTranslation();
  const save = useSaveProviderHooks(projectId ? { projectId } : {});
  const [rows, setRows] = useState<RuleRow[]>([]);

  useEffect(() => setRows(data.rules.map(toRow)), [data]);

  const readOnly = data.readOnly;
  const supportsMatcher = (event: string): boolean =>
    data.events.find((item) => item.name === event)?.supportsMatcher ?? false;

  const rules = rows
    .map((row) => toDraft(row, supportsMatcher(row.event)))
    .filter((rule): rule is ProviderHookRule => Boolean(rule));
  const dirty = stableDraft(rules) !== stableDraft(data.rules);

  const patch = (id: number, next: Partial<RuleRow>): void =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...next } : row)));

  const timeoutLabel = t(
    data.timeoutUnit === 's' ? 'providerHooks.rules.timeoutSec' : 'providerHooks.rules.timeoutMs',
    { min: data.timeoutMin, max: data.timeoutMax, default: data.timeoutDefault },
  );

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox
        title={t('providerHooks.explainTitle')}
        text={t('providerHooks.rules.explain', {
          provider: data.providerName,
          filePath: data.filePath,
        })}
      />

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="file" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerHooks.filePath')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.filePath}
          </Typography>
          {!data.present && <Badge tone="neutral">{t('providerHooks.absent')}</Badge>}
        </Stack>
      </Card>

      {/* Рубильник самого CLI: панель его не пишет, но молчать о нём нельзя —
          с ним не сработает ни одно правило раздела. */}
      {data.disableAll && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerHooks.rules.disabledAll')}
            </Typography>
          </Stack>
        </Card>
      )}

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {data.writeDisabledReason ?? t('providerHooks.readOnly', { path: data.filePath })}
            </Typography>
          </Stack>
        </Card>
      )}

      <Card padding="md">
        <Stack gap="var(--spacing-md)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="heading-sm" as="h3">
              {t('providerHooks.rules.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerHooks.rules.hint')}
            </Typography>
          </Stack>

          {rows.map((row) => (
            <Card key={row.id} padding="sm">
              <Stack gap="var(--spacing-sm)">
                <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
                  <Stack flex={1} minWidth={0}>
                    <SelectField
                      label={t('providerHooks.rules.event')}
                      value={row.event}
                      onChange={(value) => patch(row.id, { event: value })}
                      options={data.events.map((event) => ({
                        value: event.name,
                        label: event.name,
                      }))}
                    />
                  </Stack>
                  {supportsMatcher(row.event) && (
                    <Stack flex={1} minWidth={0}>
                      <TextField
                        label={t('providerHooks.rules.matcher')}
                        value={row.matcher}
                        onChange={(value) => patch(row.id, { matcher: value })}
                        placeholder="^Bash$"
                        isMono
                        disabled={readOnly}
                      />
                    </Stack>
                  )}
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Icon name="trash" size={24} />}
                      aria-label={`${t('common.delete')}: ${row.event}`}
                      onClick={() => setRows((prev) => prev.filter((item) => item.id !== row.id))}
                    />
                  )}
                </Stack>

                <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
                  <Stack flex={2} minWidth={0}>
                    <TextField
                      label={t('providerHooks.rules.command')}
                      value={row.command}
                      onChange={(value) => patch(row.id, { command: value })}
                      placeholder="./scripts/check.sh"
                      isMono
                      disabled={readOnly}
                    />
                  </Stack>
                  <Stack flex={1} minWidth={0}>
                    <TextField
                      label={timeoutLabel}
                      value={row.timeout}
                      onChange={(value) => patch(row.id, { timeout: value })}
                      placeholder={String(data.timeoutDefault ?? '')}
                      isMono
                      disabled={readOnly}
                    />
                  </Stack>
                </Stack>
              </Stack>
            </Card>
          ))}

          {rows.length === 0 && (
            <Typography color="subtle">{t('providerHooks.rules.empty')}</Typography>
          )}

          {!readOnly && data.events.length > 0 && (
            <Stack direction="row">
              <Button
                variant="secondary"
                leftIcon={<Icon name="plus" size={20} />}
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    {
                      id: nextRowId(),
                      event: data.events[0]!.name,
                      matcher: '',
                      command: '',
                      timeout: '',
                    },
                  ])
                }
              >
                {t('providerHooks.rules.add')}
              </Button>
            </Stack>
          )}
        </Stack>
      </Card>

      {data.preservedRules.length > 0 && (
        <Card padding="md">
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body" weight="medium">
              {t('providerHooks.preserved.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerHooks.rules.preservedText')}
            </Typography>
            <Stack gap="var(--spacing-3xs)">
              {data.preservedRules.map((item) => (
                <Typography key={item.key} variant="mono" color="subtle" as="span">
                  {item.key}: {item.value}
                </Typography>
              ))}
            </Stack>
          </Stack>
        </Card>
      )}

      {!readOnly && (
        <Stack direction="row" gap="var(--spacing-xs)">
          <Button onClick={() => save.mutate({ rules })} disabled={!dirty || save.isPending}>
            {t('common.save')}
          </Button>
        </Stack>
      )}

      <Typography variant="caption" color="subtle">
        {t('common.needsRestart')}
      </Typography>
    </Stack>
  );
}
