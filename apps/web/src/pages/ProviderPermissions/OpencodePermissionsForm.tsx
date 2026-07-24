import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  OpencodePermissionEntry,
  OpencodePermissionInfo,
  OpencodePermissionLevel,
  OpencodePermissionTool,
} from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field/select-field';
import { TextField } from '@shared/ui/text-field';

/**
 * Форма прав OpenCode (OPENCODE-1) — ключ `permission` файла `opencode.json`.
 * Одна и та же на глобальный раздел и на таб проекта: отличается только шапка,
 * поэтому она приходит снаружи (`header`), а состояние и правила живут здесь.
 *
 * У каждого задокументированного инструмента (`edit`, `bash`, `webfetch`) свой
 * выбор: «не задано» (ключа в файле нет — OpenCode ничего не ограничивает) либо
 * уровень `allow` / `ask` / `deny`. У `bash` дополнительно есть расширенная форма
 * — СПИСОК ШАБЛОНОВ команд («git push *» → deny), она задокументирована именно
 * для него.
 *
 * Записи внутри `permission`, которых панель не ведёт (чужие имена инструментов,
 * непонятая форма значения), показываются отдельной карточкой ТОЛЬКО ДЛЯ ЧТЕНИЯ:
 * панель их сохраняет как есть и никогда не переписывает.
 */

/** Значение селекта инструмента: «не задано», уровень или список шаблонов. */
type ToolChoice = 'unset' | OpencodePermissionLevel | 'patterns';

/** Строка списка шаблонов в форме (`id` нужен, чтобы строки не «прыгали» при вводе). */
interface PatternRow {
  id: number;
  pattern: string;
  level: OpencodePermissionLevel;
}

interface OpencodeFormState {
  choices: Record<string, ToolChoice>;
  patterns: PatternRow[];
}

/** Разложить ответ сервера в состояние формы. */
function toState(data: OpencodePermissionInfo): OpencodeFormState {
  const choices: Record<string, ToolChoice> = {};
  for (const tool of data.tools) choices[tool] = 'unset';

  let patterns: PatternRow[] = [];
  let nextId = 0;
  for (const entry of data.entries) {
    if (entry.mode === 'patterns') {
      choices[entry.tool] = 'patterns';
      patterns = (entry.patterns ?? []).map((rule) => ({
        id: nextId++,
        pattern: rule.pattern,
        level: rule.level,
      }));
    } else if (entry.level) {
      choices[entry.tool] = entry.level;
    }
  }
  return { choices, patterns };
}

/** Собрать черновик для сервера: только ЗАДАННЫЕ ограничения. */
function toEntries(
  data: OpencodePermissionInfo,
  state: OpencodeFormState,
): OpencodePermissionEntry[] {
  const entries: OpencodePermissionEntry[] = [];
  for (const tool of data.tools) {
    // Запись, которую панель не ведёт, в черновик не попадает никогда.
    if (data.preserved.some((item) => item.key === tool)) continue;

    const choice = state.choices[tool] ?? 'unset';
    if (choice === 'unset') continue;

    if (choice === 'patterns') {
      const rules = state.patterns
        .map((row) => ({ pattern: row.pattern.trim(), level: row.level }))
        .filter((row) => row.pattern.length > 0);
      if (rules.length > 0) entries.push({ tool, mode: 'patterns', patterns: rules });
      continue;
    }

    entries.push({ tool, mode: 'level', level: choice });
  }
  return entries;
}

const stable = (entries: OpencodePermissionEntry[]): string =>
  JSON.stringify(
    [...entries]
      .sort((a, b) => a.tool.localeCompare(b.tool))
      .map((entry) => [
        entry.tool,
        entry.mode,
        entry.level ?? '',
        (entry.patterns ?? []).map((rule) => [rule.pattern, rule.level]),
      ]),
  );

export interface OpencodePermissionsFormProps {
  data: OpencodePermissionInfo;
  /** Шапка раздела: своя у глобальной страницы и у таба проекта. */
  header: (state: { dirty: boolean; submit: () => void }) => React.ReactNode;
  onSave: (entries: OpencodePermissionEntry[]) => void;
}

export function OpencodePermissionsForm({ data, header, onSave }: OpencodePermissionsFormProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<OpencodeFormState>(() => toState(data));

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setState(toState(data));
  }, [data]);

  const readOnly = data.readOnly;
  const entries = toEntries(data, state);
  const dirty = stable(entries) !== stable(data.entries);

  const submit = (): void => onSave(entries);

  const setChoice = (tool: OpencodePermissionTool, choice: ToolChoice): void => {
    setState((prev) => ({
      choices: { ...prev.choices, [tool]: choice },
      // Переход на шаблоны с пустым списком — сразу даём одну строку с `*`,
      // чтобы правило по умолчанию было видно и не пришлось угадывать формат.
      patterns:
        choice === 'patterns' && prev.patterns.length === 0
          ? [{ id: 0, pattern: '*', level: 'ask' }]
          : prev.patterns,
    }));
  };

  const patchRow = (id: number, patch: Partial<PatternRow>): void => {
    setState((prev) => ({
      ...prev,
      patterns: prev.patterns.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const addRow = (): void => {
    setState((prev) => ({
      ...prev,
      patterns: [
        ...prev.patterns,
        { id: Math.max(0, ...prev.patterns.map((row) => row.id)) + 1, pattern: '', level: 'ask' },
      ],
    }));
  };

  const removeRow = (id: number): void => {
    setState((prev) => ({ ...prev, patterns: prev.patterns.filter((row) => row.id !== id) }));
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
              <Stack key={tool} gap="var(--spacing-2xs)">
                <SelectField
                  label={t(`providerPermissions.opencode.tool.${tool}.label`)}
                  value={choice}
                  onChange={(value) => setChoice(tool, value as ToolChoice)}
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
                    {state.patterns.map((row) => (
                      <Stack key={row.id} direction="row" align="end" gap="var(--spacing-xs)" wrap>
                        <Stack flex={1} minWidth={0}>
                          <TextField
                            label={t('providerPermissions.opencode.patterns.pattern')}
                            value={row.pattern}
                            onChange={(value) => patchRow(row.id, { pattern: value })}
                            placeholder={t('providerPermissions.opencode.patterns.placeholder')}
                            isMono
                            disabled={readOnly}
                          />
                        </Stack>
                        <Stack minWidth={0}>
                          <SelectField
                            label={t('providerPermissions.opencode.patterns.level')}
                            value={row.level}
                            onChange={(value) =>
                              patchRow(row.id, { level: value as OpencodePermissionLevel })
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
                            onClick={() => removeRow(row.id)}
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
                          onClick={addRow}
                        >
                          {t('providerPermissions.opencode.patterns.add')}
                        </Button>
                      </Stack>
                    )}

                    <Typography variant="caption" color="subtle">
                      {t('providerPermissions.opencode.patterns.hint')}
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
