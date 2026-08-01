import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import type { ProviderHookActionEditorProps } from './ProviderHookActionEditor.types';

/**
 * Одно действие хука OpenCode: команда и переменные окружения.
 *
 * КОМАНДА — СПИСОК АРГУМЕНТОВ, а не строка для оболочки. Это принципиально:
 * OpenCode запускает её без shell, поэтому пробел внутри аргумента безопасен, а
 * «prettier --write» одной строкой он попытается запустить как программу с таким
 * именем. Форма поэтому и сделана списком полей — чтобы этого нельзя было
 * перепутать.
 */
export function ProviderHookActionEditor({
  action,
  disabled,
  onChange,
  onRemove,
}: ProviderHookActionEditorProps) {
  const { t } = useTranslation();

  const nextId = (rows: { id: number }[]): number => Math.max(0, ...rows.map((r) => r.id)) + 1;

  return (
    <Card padding="sm">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)">
          <Typography variant="body-sm" weight="medium">
            {t('providerHooks.action.title')}
          </Typography>
          {!disabled && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="trash" size={24} />}
              aria-label={t('providerHooks.action.remove')}
              onClick={onRemove}
            />
          )}
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" color="muted">
            {t('providerHooks.action.command')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('providerHooks.action.commandHint')}
          </Typography>

          {action.command.map((item, index) => (
            <Stack key={item.id} direction="row" align="end" gap="var(--spacing-xs)" wrap>
              <Stack flex={1} minWidth={0}>
                <TextField
                  label={
                    index === 0
                      ? t('providerHooks.action.argvFirst')
                      : t('providerHooks.action.argvNth', { index })
                  }
                  value={item.value}
                  onChange={(value) =>
                    onChange({
                      command: action.command.map((row) =>
                        row.id === item.id ? { ...row, value } : row,
                      ),
                    })
                  }
                  placeholder={index === 0 ? 'prettier' : '--write'}
                  isMono
                  disabled={disabled}
                />
              </Stack>
              {!disabled && action.command.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" size={24} />}
                  aria-label={`${t('common.delete')}: ${item.value}`}
                  onClick={() =>
                    onChange({ command: action.command.filter((row) => row.id !== item.id) })
                  }
                />
              )}
            </Stack>
          ))}

          {!disabled && (
            <Stack direction="row">
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="plus" size={20} />}
                onClick={() =>
                  onChange({
                    command: [...action.command, { id: nextId(action.command), value: '' }],
                  })
                }
              >
                {t('providerHooks.action.addArg')}
              </Button>
            </Stack>
          )}
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" color="muted">
            {t('providerHooks.action.environment')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('providerHooks.action.environmentHint')}
          </Typography>

          {action.env.map((pair) => (
            <Stack key={pair.id} direction="row" align="end" gap="var(--spacing-xs)" wrap>
              <Stack flex={1} minWidth={0}>
                <TextField
                  label={t('providerHooks.action.envKey')}
                  value={pair.key}
                  onChange={(value) =>
                    onChange({
                      env: action.env.map((row) =>
                        row.id === pair.id ? { ...row, key: value } : row,
                      ),
                    })
                  }
                  placeholder="NODE_ENV"
                  isMono
                  disabled={disabled}
                />
              </Stack>
              <Stack flex={1} minWidth={0}>
                <TextField
                  label={t('providerHooks.action.envValue')}
                  value={pair.value}
                  onChange={(value) =>
                    onChange({
                      env: action.env.map((row) => (row.id === pair.id ? { ...row, value } : row)),
                    })
                  }
                  placeholder="development"
                  isMono
                  disabled={disabled}
                />
              </Stack>
              {!disabled && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" size={24} />}
                  aria-label={`${t('common.delete')}: ${pair.key}`}
                  onClick={() => onChange({ env: action.env.filter((row) => row.id !== pair.id) })}
                />
              )}
            </Stack>
          ))}

          {!disabled && (
            <Stack direction="row">
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="plus" size={20} />}
                onClick={() =>
                  onChange({
                    env: [...action.env, { id: nextId(action.env), key: '', value: '' }],
                  })
                }
              >
                {t('providerHooks.action.addEnv')}
              </Button>
            </Stack>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
