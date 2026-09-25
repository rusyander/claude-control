import { useTranslation } from 'react-i18next';
import { GROUP_PERMISSION_LEVELS, type GroupRequestId } from '@agentdeck/contracts/split-groups';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import type { GroupPermissionRowsProps } from './GroupPermissionRows.types';

/**
 * Подпись строки: «обычная работа» — своя, у именованных правил — те же слова,
 * что в меню прав чата, чтобы одно правило не называлось двумя именами.
 */
function labelKeys(id: GroupRequestId): { label: string; hint: string } {
  return id === 'routine'
    ? { label: 'settings.groups.routine', hint: 'settings.groups.routineHint' }
    : { label: `chat.rules.${id}`, hint: `chat.rules.${id}Hint` };
}

/**
 * Строки разрешений групп, три положения на строку (аудит 25.09, L51): «Сама»,
 * «Сама с отметкой» — прошло без человека, но хаб это покажет, — и «Человеку».
 * Тумблер давал только крайние два, и середины «пусть идёт, но я хочу знать» не было.
 */
export function GroupPermissionRows({
  rows,
  showOrigin,
  disabled,
  onChange,
}: GroupPermissionRowsProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-sm)">
      {rows.map((row) => {
        const keys = labelKeys(row.id);
        return (
          <Stack
            key={row.id}
            direction="row"
            align="center"
            justify="between"
            gap="var(--spacing-md)"
          >
            <Stack gap="var(--spacing-3xs)" style={{ maxWidth: 'var(--text-measure)' }}>
              <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                <Typography variant="body-sm" as="span">
                  {t(keys.label)}
                </Typography>
                {showOrigin && (
                  <Badge tone={row.own ? 'accent' : 'neutral'}>
                    {row.own ? t('settings.groups.own') : t('settings.groups.inherited')}
                  </Badge>
                )}
              </Stack>
              <Typography variant="caption" color="subtle" as="span">
                {t(keys.hint)}
              </Typography>
            </Stack>
            <Stack
              direction="row"
              gap="var(--spacing-3xs)"
              role="radiogroup"
              aria-label={t(keys.label)}
              wrap
            >
              {GROUP_PERMISSION_LEVELS.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={row.level === level ? 'primary' : 'ghost'}
                  role="radio"
                  aria-checked={row.level === level}
                  disabled={disabled}
                  onClick={() => row.level !== level && onChange(row.id, level)}
                >
                  {t(`settings.groups.level.${level}`)}
                </Button>
              ))}
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}
