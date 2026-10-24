import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { GROUP_ECONOMY_DEFAULTS, type GroupEconomy } from '@agentdeck/contracts/group-economy';
import type { GroupEconomyLever } from '@agentdeck/contracts/group-economy-support';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { useProviders } from '@entities/Provider';
import { SettingToggleRow } from '../SettingToggleRow/SettingToggleRow';
import { GroupEconomySupport } from '../GroupEconomySupport/GroupEconomySupport';
import type { SettingsTabProps } from '../SettingsTabs.types';

// Немного полезных значений вместо свободного числа: опечатка на порядок в поле
// дала бы группе окно, которое CLI молча отверг бы. Ноль — «как у CLI».
const WINDOW_VALUES = [0, 120_000, 160_000, 200_000, 250_000];
const BASH_VALUES = [0, 4_000, 8_000, 16_000, 30_000];
const READ_VALUES = [0, 5_000, 10_000, 25_000];
const PING_VALUES = [1, 2, 3, 5, 9];

const NUMBER_LABELS = {
  compactWindow: ['groupCompactWindow', 'tokens', 1000],
  bashOutputChars: ['groupBashOutput', 'chars', 1],
  readOutputTokens: ['groupReadOutput', 'tokens', 1000],
} as const;

type NumberLever = keyof typeof NUMBER_LABELS;

/**
 * Рычаги экономии групп разделения (замер прогона 20.10.2026). Каждый
 * выключается отдельно, панель перезапускать не нужно. Порог сжатия, доставка на
 * Sonnet, новый разговор после паузы и тёплый кэш ожидания читаются на ходу; остальные закрепляются на
 * первом старте разговора (`pinLinkEconomy`) — смена посреди него переписала бы кэш.
 */
export function GroupEconomyCard({ settings, patch }: SettingsTabProps) {
  const { t, i18n } = useTranslation();
  // Старые настройки без поля — те же значения, что сервер подставит сам.
  const economy = { ...GROUP_ECONOMY_DEFAULTS, ...settings.groupEconomy };
  // Только изменённый ключ: сервер сливает его с сохранённым. Целый блок по
  // снимку страницы затирал правку, сделанную за миг до этого.
  const patchEconomy = (next: Partial<GroupEconomy>): void => patch({ groupEconomy: next });
  // Переменная панели сильнее порога (F-19): выбор ниже тогда не действует, и
  // карточка говорит об этом, а не показывает порог, с которым группы не идут.
  const { data: system } = useQuery({
    queryKey: queryKeys.system,
    queryFn: async () =>
      (await apiClient.get<{ groupCompactWindowEnv?: number | null }>('/system')).data,
    staleTime: Infinity,
  });
  const envWindow = system?.groupCompactWindowEnv;
  // Где действует каждый рычаг — из каталогов CLI; списка ещё нет — строк отметок нет.
  const providers = useProviders().data?.providers ?? [];
  const support = (lever: GroupEconomyLever) => (
    <GroupEconomySupport lever={lever} providers={providers} />
  );

  // Значение по умолчанию помечено; чужое текущее (правка файла руками) не теряется.
  const numberOptions = (key: NumberLever, values: number[]) => {
    const [prefix, param, unit] = NUMBER_LABELS[key];
    const label = (value: number): string => {
      if (value === 0) return t(`settings.${prefix}Off`);
      const amount = (value / unit).toLocaleString(i18n.language);
      return value === GROUP_ECONOMY_DEFAULTS[key]
        ? t(`settings.${prefix}Default`, { [param]: amount })
        : t(`settings.${prefix}Value`, { [param]: amount });
    };
    const all = values.includes(economy[key]) ? values : [...values, economy[key]];
    return all.map((value) => ({ value: String(value), label: label(value) }));
  };

  // Пинг — на 50-й минуте после прошлого, кэш живёт час: N пингов держат его
  // тёплым N·50 + 60 минут ожидания. Подпись говорит часы, а не счёт.
  const pingOptions = (
    PING_VALUES.includes(economy.keepWarmPings)
      ? PING_VALUES
      : [...PING_VALUES, economy.keepWarmPings]
  ).map((count) => {
    const hours = ((count * 50 + 60) / 60).toLocaleString(i18n.language, {
      maximumFractionDigits: 1,
    });
    return {
      value: String(count),
      label:
        count === GROUP_ECONOMY_DEFAULTS.keepWarmPings
          ? t('settings.groupKeepWarmPingsDefault', { count, hours })
          : t('settings.groupKeepWarmPingsValue', { count, hours }),
    };
  });

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('settings.groupEconomyTitle')}
        </Typography>
        <Typography variant="body-sm" color="subtle">
          {t('settings.groupEconomyHint')}
        </Typography>

        <SelectField
          label={t('settings.groupCompactWindow')}
          value={String(economy.compactWindow)}
          onChange={(value) => patchEconomy({ compactWindow: Number(value) })}
          options={numberOptions('compactWindow', WINDOW_VALUES)}
          hint={t('settings.groupCompactWindowHint')}
        />
        {support('compactWindow')}
        {envWindow ? (
          <Typography variant="body-sm" color="warning" role="status">
            {t('settings.groupCompactWindowEnv', {
              tokens: (envWindow / 1000).toLocaleString(i18n.language),
            })}
          </Typography>
        ) : null}
        <SelectField
          label={t('settings.groupBashOutput')}
          value={String(economy.bashOutputChars)}
          onChange={(value) => patchEconomy({ bashOutputChars: Number(value) })}
          options={numberOptions('bashOutputChars', BASH_VALUES)}
          hint={t('settings.groupBashOutputHint')}
        />
        {support('bashOutputChars')}
        <SelectField
          label={t('settings.groupReadOutput')}
          value={String(economy.readOutputTokens)}
          onChange={(value) => patchEconomy({ readOutputTokens: Number(value) })}
          options={numberOptions('readOutputTokens', READ_VALUES)}
          hint={t('settings.groupReadOutputHint')}
        />
        {support('readOutputTokens')}
        <SelectField
          label={t('settings.groupCacheTtl')}
          value={economy.cacheTtl}
          onChange={(value) => patchEconomy({ cacheTtl: value as GroupEconomy['cacheTtl'] })}
          options={[
            { value: '', label: t('settings.groupCacheTtlAuto') },
            { value: '5m', label: t('settings.groupCacheTtl5m') },
            { value: '1h', label: t('settings.groupCacheTtl1h') },
          ]}
          hint={t('settings.groupCacheTtlHint')}
        />
        {support('cacheTtl')}
        <SettingToggleRow
          label={t('settings.groupSonnetDeliver')}
          hint={t('settings.groupSonnetDeliverHint')}
          checked={economy.sonnetDeliver}
          onChange={(sonnetDeliver) => patchEconomy({ sonnetDeliver })}
        />
        {support('sonnetDeliver')}
        <SettingToggleRow
          label={t('settings.groupFreshOnColdResume')}
          hint={t('settings.groupFreshOnColdResumeHint')}
          checked={economy.freshOnColdResume}
          onChange={(freshOnColdResume) => patchEconomy({ freshOnColdResume })}
        />
        {support('freshOnColdResume')}
        <SettingToggleRow
          label={t('settings.groupKeepWarm')}
          hint={t('settings.groupKeepWarmHint')}
          checked={economy.keepWarm}
          onChange={(keepWarm) => patchEconomy({ keepWarm })}
        />
        {support('keepWarm')}
        <SelectField
          label={t('settings.groupKeepWarmPings')}
          value={String(economy.keepWarmPings)}
          onChange={(value) => patchEconomy({ keepWarmPings: Number(value) })}
          options={pingOptions}
          hint={t('settings.groupKeepWarmPingsHint')}
          disabled={!economy.keepWarm}
        />
        <SettingToggleRow
          label={t('settings.groupDetachIde')}
          hint={t('settings.groupDetachIdeHint')}
          checked={economy.detachIde}
          onChange={(detachIde) => patchEconomy({ detachIde })}
        />
        {support('detachIde')}
        <SettingToggleRow
          label={t('settings.groupWorkHabits')}
          hint={t('settings.groupWorkHabitsHint')}
          checked={economy.workHabits}
          onChange={(workHabits) => patchEconomy({ workHabits })}
        />
        {support('workHabits')}
      </Stack>
    </Card>
  );
}
