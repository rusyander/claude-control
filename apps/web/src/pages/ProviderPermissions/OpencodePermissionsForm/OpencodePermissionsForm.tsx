import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OpencodePermissionLevel, OpencodePermissionTool } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field/select-field';
import { TextField } from '@shared/ui/text-field';
import {
  toOpencodeFormState,
  toOpencodeEntries,
  stableOpencodeEntries,
  type OpencodeFormState,
  type OpencodePatternRow,
  type OpencodeToolChoice,
} from '@entities/ProviderPermissions';
import type { OpencodePermissionsFormProps } from '../ProviderPermissionsForm.types';

/**
 * Форма прав OpenCode (OPENCODE-1) — ключ `permission` файла `opencode.json`.
 * Одна и та же на глобальный раздел и на таб проекта: отличается только шапка,
 * поэтому она приходит снаружи (`header`), а состояние и правила живут здесь.
 *
 * У каждого инструмента (`edit`, `bash`, `webfetch`, `read`) свой выбор: «не
 * задано» (ключа в файле нет — OpenCode ничего не ограничивает) либо уровень
 * `allow` / `ask` / `deny`. У `bash` и `read` дополнительно есть расширенная
 * форма — СПИСОК ШАБЛОНОВ: команд («git push *» → deny) и путей файлов
 * («**» и косая перед «.env» → deny); у каждого из двух свой список.
 *
 * Записи внутри `permission`, которых панель не ведёт (чужие имена инструментов,
 * непонятая форма значения), показываются отдельной карточкой ТОЛЬКО ДЛЯ ЧТЕНИЯ:
 * панель их сохраняет как есть и никогда не переписывает.
 */
export function OpencodePermissionsForm({ data, header, onSave }: OpencodePermissionsFormProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<OpencodeFormState>(() => toOpencodeFormState(data));

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setState(toOpencodeFormState(data));
  }, [data]);

  const readOnly = data.readOnly;
  const entries = toOpencodeEntries(data, state);
  const dirty = stableOpencodeEntries(entries) !== stableOpencodeEntries(data.entries);

  const submit = (): void => onSave(entries);

  const setChoice = (tool: OpencodePermissionTool, choice: OpencodeToolChoice): void => {
    setState((prev) => ({
      choices: { ...prev.choices, [tool]: choice },
      // Переход на шаблоны с пустым списком — сразу даём одну строку с `*`,
      // чтобы правило по умолчанию было видно и не пришлось угадывать формат.
      patterns:
        choice === 'patterns' && (prev.patterns[tool] ?? []).length === 0
          ? { ...prev.patterns, [tool]: [{ id: 0, pattern: '*', level: 'ask' }] }
          : prev.patterns,
    }));
  };

  const setRows = (
    tool: OpencodePermissionTool,
    change: (rows: OpencodePatternRow[]) => OpencodePatternRow[],
  ): void => {
    setState((prev) => ({
      ...prev,
      patterns: { ...prev.patterns, [tool]: change(prev.patterns[tool] ?? []) },
    }));
  };

  const patchRow = (
    tool: OpencodePermissionTool,
    id: number,
    patch: Partial<OpencodePatternRow>,
  ): void => {
    setRows(tool, (rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = (tool: OpencodePermissionTool): void => {
    setRows(tool, (rows) => [
      ...rows,
      { id: Math.max(0, ...rows.map((row) => row.id)) + 1, pattern: '', level: 'ask' },
    ]);
  };

  const removeRow = (tool: OpencodePermissionTool, id: number): void => {
    setRows(tool, (rows) => rows.filter((row) => row.id !== id));
  };

  const levelOptions = data.levels.map((level) => ({
    value: level,
    label: t(`providerPermissions.opencode.level.${level}.label`),
  }));

  return (
    <Stack gap="var(--spacing-lg)">
      {header({ dirty, submit })}

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

      {data.usingDefaults && !readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="info" size={18} />
            <Typography variant="body-sm" color="muted">
              {t('providerPermissions.opencode.usingDefaults')}
            </Typography>
          </Stack>
        </Card>
      )}

      <Card padding="md">
        <Stack gap="var(--spacing-lg)">
          {data.tools.map((tool) => {
            const preserved = data.preserved.find((item) => item.key === tool);
            if (preserved) return null;

            const choice = state.choices[tool] ?? 'unset';
            const options = [
              { value: 'unset', label: t('providerPermissions.opencode.unset.label') },
              ...levelOptions,
              ...(data.patternTools.includes(tool)
                ? [{ value: 'patterns', label: t('providerPermissions.opencode.patterns.label') }]
                : []),
            ];

            return (
              <Stack key={tool} gap="var(--spacing-2xs)" data-opencode-tool={tool}>
                <SelectField
                  label={t(`providerPermissions.opencode.tool.${tool}.label`)}
                  value={choice}
                  onChange={(value) => setChoice(tool, value as OpencodeToolChoice)}
                  options={options}
                />
                <Typography variant="caption" color="subtle">
                  {t(`providerPermissions.opencode.tool.${tool}.hint`)}
                </Typography>
                <Typography variant="caption" color={choice === 'allow' ? 'warning' : 'subtle'}>
                  {choice === 'unset' || choice === 'patterns'
                    ? t(`providerPermissions.opencode.${choice}.description`)
                    : t(`providerPermissions.opencode.level.${choice}.description`)}
                </Typography>

                {choice === 'patterns' && (
                  <Stack gap="var(--spacing-xs)" padding="var(--spacing-xs) 0 0 0">
                    {(state.patterns[tool] ?? []).map((row) => (
                      <Stack key={row.id} direction="row" align="end" gap="var(--spacing-xs)" wrap>
                        <Stack flex={1} minWidth={0}>
                          <TextField
                            label={t('providerPermissions.opencode.patterns.pattern')}
                            value={row.pattern}
                            onChange={(value) => patchRow(tool, row.id, { pattern: value })}
                            placeholder={t(
                              `providerPermissions.opencode.patterns.${tool}.placeholder`,
                            )}
                            isMono
                            disabled={readOnly}
                          />
                        </Stack>
                        <Stack minWidth={0}>
                          <SelectField
                            label={t('providerPermissions.opencode.patterns.level')}
                            value={row.level}
                            onChange={(value) =>
                              patchRow(tool, row.id, { level: value as OpencodePermissionLevel })
                            }
                            options={levelOptions}
                          />
                        </Stack>
                        {!readOnly && (
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon={<Icon name="trash" size={24} />}
                            aria-label={`${t('common.delete')}: ${row.pattern}`}
                            onClick={() => removeRow(tool, row.id)}
                          />
                        )}
                      </Stack>
                    ))}

                    {!readOnly && (
                      <Stack direction="row">
                        <Button
                          size="sm"
                          variant="secondary"
                          leftIcon={<Icon name="plus" size={20} />}
                          onClick={() => addRow(tool)}
                        >
                          {t('providerPermissions.opencode.patterns.add')}
                        </Button>
                      </Stack>
                    )}

                    <Typography variant="caption" color="subtle">
                      {t(`providerPermissions.opencode.patterns.${tool}.hint`)}
                    </Typography>
                  </Stack>
                )}
              </Stack>
            );
          })}
        </Stack>
      </Card>

      {data.preserved.length > 0 && (
        <Card padding="md">
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body" weight="medium">
              {t('providerPermissions.opencode.preserved.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerPermissions.opencode.preserved.text')}
            </Typography>
            <Stack gap="var(--spacing-3xs)">
              {data.preserved.map((item) => (
                <Typography key={item.key} variant="mono" color="subtle" as="span">
                  {item.key}: {item.value}
                </Typography>
              ))}
            </Stack>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
