import { useTranslation } from 'react-i18next';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { SettingToggleRow } from '../SettingToggleRow/SettingToggleRow';
import type { SettingsTabProps } from '../SettingsTabs.types';

type Unit =
  | 'minutes'
  | 'tokens'
  | 'times'
  | 'perHour'
  | 'percent'
  | 'count'
  | 'weight'
  | 'kchars'
  | 'groups'
  | 'files';

/** Единицы, которые показываются в тысячах: токены и знаки. */
const IN_THOUSANDS: ReadonlySet<Unit> = new Set(['tokens', 'kchars']);
type Threshold = Exclude<keyof GroupWatch, 'enabled' | 'singleChats'>;

/**
 * Порог → единица и несколько осмысленных значений. Набор вместо свободного
 * числа: опечатка на порядок дала бы сторожа, который молчит или кричит всегда.
 * Чужое текущее значение (правка файла руками) добавляется в список, не теряется.
 */
const THRESHOLDS: ReadonlyArray<readonly [Threshold, Unit, readonly number[]]> = [
  ['stallMinutes', 'minutes', [10, 15, 20, 30, 45, 60]],
  ['askMinutes', 'minutes', [5, 10, 15, 30, 60]],
  ['askAlertMinutes', 'minutes', [30, 60, 120, 240]],
  ['coldGapMinutes', 'minutes', [5, 30, 55, 90]],
  ['coldContextTokens', 'tokens', [60_000, 85_000, 120_000, 200_000]],
  ['compactMinutes', 'minutes', [10, 15, 30]],
  ['checkRepeats', 'times', [2, 3, 4, 5]],
  ['rereadRepeats', 'times', [2, 3, 4, 5]],
  ['burnPerHour', 'perHour', [20, 40, 60, 100]],
  ['burnMinutes', 'minutes', [10, 15, 30]],
  ['projectionPercent', 'percent', [75, 90, 100]],
  ['projectionMinutes', 'minutes', [15, 30, 60]],
  ['fanoutSpawns', 'count', [4, 6, 10, 15]],
  ['fanoutWeight', 'weight', [10, 20, 40, 80]],
  ['fanoutMinutes', 'minutes', [30, 60, 120]],
  ['bigResultChars', 'kchars', [10_000, 20_000, 40_000]],
  ['persistedChars', 'kchars', [4_000, 8_000, 16_000]],
  ['longCallMinutes', 'minutes', [8, 12, 20, 30]],
  ['queueWaitMinutes', 'minutes', [5, 10, 20]],
  ['denialRepeats', 'times', [3, 5, 8]],
  ['denialMinutes', 'minutes', [10, 15, 30]],
  ['firstContextTokens', 'tokens', [70_000, 90_000, 120_000]],
  ['gateRepeats', 'times', [2, 3, 5]],
  ['heavyCheckMinutes', 'minutes', [3, 5, 10]],
  ['silentStopMinutes', 'minutes', [10, 20, 30, 60]],
  ['crossGroupCount', 'groups', [2, 3, 4]],
  ['crossGroupMinutes', 'minutes', [30, 60, 120]],
  ['errorRepeats', 'times', [2, 3, 4, 5]],
  ['errorMinutes', 'minutes', [15, 30, 60]],
  ['bypassMinutes', 'minutes', [15, 30, 60]],
  ['proseWaitMinutes', 'minutes', [5, 10, 20, 30]],
  ['nudgeRepeats', 'times', [1, 2, 3]],
  ['missingToolRepeats', 'times', [1, 2, 3]],
  ['outageRepeats', 'times', [2, 3, 5]],
  ['outageMinutes', 'minutes', [10, 15, 30]],
  ['insertChars', 'kchars', [10_000, 20_000, 40_000]],
  ['insertMinutes', 'minutes', [10, 15, 30]],
  ['freshRewriteTokens', 'tokens', [30_000, 50_000, 100_000]],
  ['redoFiles', 'files', [1, 2, 3, 5]],
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
  // Окно остывшего кэша читает и пинг тёплого кэша — при выключенном стороже тоже.
  // Заблокировать порог, который всё ещё решает, значило бы спрятать рычаг.
  const keepWarm = (settings.groupEconomy ?? GROUP_ECONOMY_DEFAULTS).keepWarm;
  const readByPing = (key: Threshold): boolean => keepWarm && key === 'coldContextTokens';

  const options = (key: Threshold, unit: Unit, values: readonly number[]) => {
    const all = values.includes(watch[key]) ? values : [...values, watch[key]];
    return all.map((value) => {
      const shown = IN_THOUSANDS.has(unit) ? value / 1000 : value;
      // `count` выбирает форму «раз/раза», «запуск/запусков»; у единиц без форм он ни на что не влияет.
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
        {/* Одиночные разговоры — тот же сторож, поэтому без него рычаг ничего не решает. */}
        <SettingToggleRow
          label={t('groupWatch.settings.singleChats')}
          hint={t('groupWatch.settings.singleChatsHint')}
          checked={watch.singleChats}
          disabled={!watch.enabled}
          onChange={(singleChats) => patchWatch({ singleChats })}
        />
        {/* Подписка на сигналы — событием `groupSignal` у Telegram и вебхука, не своим выключателем. */}
        <Typography variant="body-sm" color="subtle">
          {t('groupWatch.settings.delivery')}
        </Typography>
        {/* Выключенный сторож порогов не читает: правка выглядела бы действием, а ничего не меняет. */}
        {!watch.enabled && (
          <Typography variant="body-sm" color="subtle" data-group-watch-off>
            {t(
              keepWarm
                ? 'groupWatch.settings.thresholdsOffKeepWarm'
                : 'groupWatch.settings.thresholdsOff',
            )}
          </Typography>
        )}
        {THRESHOLDS.map(([key, unit, values]) => (
          <SelectField
            key={key}
            label={t(`groupWatch.settings.field.${key}`)}
            {...(readByPing(key) ? { hint: t('groupWatch.settings.coldContextKeepWarm') } : {})}
            disabled={!watch.enabled && !readByPing(key)}
            value={String(watch[key])}
            onChange={(value) => patchWatch({ [key]: Number(value) })}
            options={options(key, unit, values)}
          />
        ))}
      </Stack>
    </Card>
  );
}
