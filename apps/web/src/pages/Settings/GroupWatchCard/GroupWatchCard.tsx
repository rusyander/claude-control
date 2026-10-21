import { useTranslation } from 'react-i18next';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { SettingToggleRow } from '../SettingToggleRow/SettingToggleRow';
import type { SettingsTabProps } from '../SettingsTabs.types';

type Unit = 'minutes' | 'tokens' | 'times' | 'perHour' | 'percent';
type Threshold = Exclude<keyof GroupWatch, 'enabled' | 'telegram'>;

/**
 * Порог → единица и несколько осмысленных значений. Набор вместо свободного
 * числа: опечатка на порядок дала бы сторожа, который молчит или кричит всегда.
 * Чужое текущее значение (правка файла руками) добавляется в список, не теряется.
 */
const THRESHOLDS: ReadonlyArray<readonly [Threshold, Unit, readonly number[]]> = [
  ['stallMinutes', 'minutes', [10, 15, 20, 30, 45, 60]],
  ['askMinutes', 'minutes', [5, 10, 15, 30, 60]],
  ['coldGapMinutes', 'minutes', [5, 30, 55, 90]],
  ['coldContextTokens', 'tokens', [60_000, 85_000, 120_000, 200_000]],
  ['compactMinutes', 'minutes', [10, 15, 30]],
  ['checkRepeats', 'times', [2, 3, 4, 5]],
  ['rereadRepeats', 'times', [2, 3, 4, 5]],
  ['burnPerHour', 'perHour', [20, 40, 60, 100]],
  ['burnMinutes', 'minutes', [10, 15, 30]],
  ['projectionPercent', 'percent', [75, 90, 100]],
  ['projectionMinutes', 'minutes', [15, 30, 60]],
  ['cooldownMinutes', 'minutes', [15, 30, 60, 120]],
];

/**
 * Сторож групп разделения (фаза 2, W): включение, Telegram и пороги правил.
 * Читаются на ходу — следующее событие звена уже идёт по новым числам.
 */
export function GroupWatchCard({ settings, patch }: SettingsTabProps) {
  const { t, i18n } = useTranslation();
  // Старые настройки без поля — те же значения, что сервер подставит сам.
  const watch = { ...GROUP_WATCH_DEFAULTS, ...settings.groupWatch };
  // Только изменённый ключ: сервер сливает его с сохранённым.
  const patchWatch = (next: Partial<GroupWatch>): void => patch({ groupWatch: next });

  const options = (key: Threshold, unit: Unit, values: readonly number[]) => {
    const all = values.includes(watch[key]) ? values : [...values, watch[key]];
    return all.map((value) => {
      const shown = unit === 'tokens' ? value / 1000 : value;
      // `count` выбирает форму «раз/раза»; у единиц без форм он ни на что не влияет.
      const text = t(`groupWatch.settings.unit.${unit}`, {
        value: shown.toLocaleString(i18n.language),
        count: shown,
      });
      return {
        value: String(value),
        label:
          value === GROUP_WATCH_DEFAULTS[key]
            ? t('groupWatch.settings.defaultValue', { value: text })
            : text,
      };
    });
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('groupWatch.settings.title')}
        </Typography>
        <Typography variant="body-sm" color="subtle">
          {t('groupWatch.settings.hint')}
        </Typography>
        <SettingToggleRow
          label={t('groupWatch.settings.enabled')}
          hint={t('groupWatch.settings.enabledHint')}
          checked={watch.enabled}
          onChange={(enabled) => patchWatch({ enabled })}
        />
        <SettingToggleRow
          label={t('groupWatch.settings.telegram')}
          hint={t('groupWatch.settings.telegramHint')}
          checked={watch.telegram}
          onChange={(telegram) => patchWatch({ telegram })}
        />
        {THRESHOLDS.map(([key, unit, values]) => (
          <SelectField
            key={key}
            label={t(`groupWatch.settings.field.${key}`)}
            value={String(watch[key])}
            onChange={(value) => patchWatch({ [key]: Number(value) })}
            options={options(key, unit, values)}
          />
        ))}
      </Stack>
    </Card>
  );
}
