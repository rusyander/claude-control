import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  KimiDecision,
  KimiMode,
  KimiPermissionInfo,
  KimiPermissionRule,
} from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field/select-field';
import { TextField } from '@shared/ui/text-field';

/**
 * Форма прав Kimi Code — `default_permission_mode` и массив таблиц
 * `[[permission.rules]]` файла `config.toml`. Одна и та же на глобальный раздел и
 * на таб проекта: отличается только шапка, поэтому она приходит снаружи.
 *
 * ПОРЯДОК ПРАВИЛ ЗНАЧИМ (это массив, а не карта), поэтому строки редактируются
 * списком со стрелками вверх/вниз, а не тремя текстовыми полями по решениям.
 * Синтаксис шаблона (`Read`, `Bash(git push*)`, `mcp__сервер__инструмент`)
 * панель не толкует и хранит как есть; пустые строки при сохранении отбрасываются.
 */

/** Строка формы: `id` нужен, чтобы строки не «прыгали» при вводе. */
interface RuleRow {
  id: number;
  decision: KimiDecision;
  pattern: string;
}

const toRows = (rules: readonly KimiPermissionRule[]): RuleRow[] =>
  rules.map((rule, index) => ({ id: index, decision: rule.decision, pattern: rule.pattern }));

/** Черновик для сервера: пустые шаблоны выбрасываются, порядок сохраняется. */
const toRules = (rows: readonly RuleRow[]): KimiPermissionRule[] =>
  rows
    .map((row) => ({ decision: row.decision, pattern: row.pattern.trim() }))
    .filter((rule) => rule.pattern.length > 0);

const stable = (rules: readonly KimiPermissionRule[]): string =>
  JSON.stringify(rules.map((rule) => [rule.decision, rule.pattern]));

/** Черновик, который форма отдаёт наружу на сохранение. */
export interface KimiPermissionsDraft {
  mode: KimiMode;
  rules: KimiPermissionRule[];
}

export interface KimiPermissionsFormProps {
  data: KimiPermissionInfo;
  onSave: (draft: KimiPermissionsDraft) => void;
  /** Шапка раздела: своя у глобальной страницы и у таба проекта. */
  header: (state: { dirty: boolean; submit: () => void }) => React.ReactNode;
}

export function KimiPermissionsForm({ data, header, onSave }: KimiPermissionsFormProps) {
  const { t } = useTranslation();

  const [mode, setMode] = useState<KimiMode>(data.mode);
  const [rows, setRows] = useState<RuleRow[]>(() => toRows(data.rules));

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setMode(data.mode);
    setRows(toRows(data.rules));
  }, [data]);

  const readOnly = data.readOnly;
  const rules = toRules(rows);
  const dirty = mode !== data.mode || stable(rules) !== stable(data.rules);

  const modeOptions = data.modes.map((value) => ({
    value,
    label: t(`providerPermissions.kimi.mode.${value}.label`),
  }));
  const decisionOptions = data.decisions.map((value) => ({
    value,
    label: t(`providerPermissions.kimi.decision.${value}.label`),
  }));

  const patchRow = (id: number, patch: Partial<RuleRow>): void => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    setRows((prev) => [
      ...prev,
      { id: Math.max(-1, ...prev.map((row) => row.id)) + 1, decision: 'ask', pattern: '' },
    ]);
  };

  const removeRow = (id: number): void => setRows((prev) => prev.filter((row) => row.id !== id));

  /** Сдвиг строки на шаг: порядок правил значим, менять его нужно явно. */
  const moveRow = (id: number, step: -1 | 1): void => {
    setRows((prev) => {
      const index = prev.findIndex((row) => row.id === id);
      const target = index + step;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const submit = (): void => onSave({ mode, rules });

  return (
    <Stack gap="var(--spacing-lg)">
      {header({ dirty, submit })}

      <Card padding="md">
        <Stack gap="var(--spacing-lg)">
          <Stack gap="var(--spacing-2xs)">
            <SelectField
              label={t('providerPermissions.kimi.mode.label')}
              value={mode}
              onChange={(value: string) => setMode(value as KimiMode)}
              options={modeOptions}
            />
            <Typography variant="caption" color={mode === 'yolo' ? 'warning' : 'subtle'}>
              {t(`providerPermissions.kimi.mode.${mode}.description`)}
            </Typography>
          </Stack>

          <Stack gap="var(--spacing-xs)">
            <Typography variant="body" weight="medium">
              {t('providerPermissions.kimi.rules.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerPermissions.kimi.rules.hint')}
            </Typography>

            {rows.map((row, index) => (
              <Stack key={row.id} direction="row" align="end" gap="var(--spacing-xs)" wrap>
                <Stack flex={1} minWidth={0}>
                  <TextField
                    label={t('providerPermissions.kimi.rules.pattern')}
                    value={row.pattern}
                    onChange={(value) => patchRow(row.id, { pattern: value })}
                    placeholder={t('providerPermissions.kimi.rules.placeholder')}
                    isMono
                    disabled={readOnly}
                  />
                </Stack>
                <Stack minWidth={0}>
                  <SelectField
                    label={t('providerPermissions.kimi.rules.decision')}
                    value={row.decision}
                    onChange={(value: string) =>
                      patchRow(row.id, { decision: value as KimiDecision })
                    }
                    options={decisionOptions}
                  />
                </Stack>
                {!readOnly && (
                  <Stack direction="row" gap="var(--spacing-3xs)">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Icon name="chevronUp" size={24} />}
                      aria-label={t('providerPermissions.kimi.rules.moveUp')}
                      disabled={index === 0}
                      onClick={() => moveRow(row.id, -1)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Icon name="chevronDown" size={24} />}
                      aria-label={t('providerPermissions.kimi.rules.moveDown')}
                      disabled={index === rows.length - 1}
                      onClick={() => moveRow(row.id, 1)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Icon name="trash" size={24} />}
                      aria-label={`${t('common.delete')}: ${row.pattern}`}
                      onClick={() => removeRow(row.id)}
                    />
                  </Stack>
                )}
              </Stack>
            ))}

            {!readOnly && (
              <Stack direction="row">
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="plus" size={20} />}
                  onClick={addRow}
                >
                  {t('providerPermissions.kimi.rules.add')}
                </Button>
              </Stack>
            )}
          </Stack>
        </Stack>
      </Card>
    </Stack>
  );
}
