import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupEconomyLever } from '@agentdeck/contracts/group-economy-support';
import { failureOf, failureReason } from '@entities/CoreTask';
import { useProviders } from '@entities/Provider';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { GroupEconomySupport } from '../GroupEconomySupport/GroupEconomySupport';
import { SettingToggleRow } from '../SettingToggleRow/SettingToggleRow';
import {
  CORE_ECONOMY_SHOWN_DEFAULTS,
  coreEconomyIssue,
  coreEconomyOf,
  type CoreEconomyValues,
} from './coreEconomy';
import { useCoreEconomyConfig, useSaveCoreEconomy } from './useCoreEconomy';

// Немного полезных значений вместо свободного числа: опечатка на порядок дала бы шагу окно,
// которое схема ядра отвергла бы. Ноль — «как у CLI»; границы — `economySectionSchema`.
const WINDOW_VALUES = [0, 120_000, 160_000, 200_000, 250_000];
const BASH_VALUES = [0, 4_000, 8_000, 16_000, 30_000];
const READ_VALUES = [0, 5_000, 10_000, 25_000];

const NUMBER_LABELS = {
  compactWindow: ['compactWindow', 'tokens', 1000],
  bashOutputChars: ['bashOutput', 'chars', 1],
  readOutputTokens: ['readOutput', 'tokens', 1000],
} as const;

type NumberLever = keyof typeof NUMBER_LABELS;

const P = 'settings.coreEconomy';

/**
 * «Экономия шагов задачи»: рычаги раздела `economy` настройки ядра. Ядро читает их на каждом
 * старте сессии шага — правка действует со следующего шага, без перезапуска. Ядро не отвечает —
 * карточка так и говорит, а не рисует рычаги, которые некуда записать.
 */
export function CoreEconomyCard() {
  const { t, i18n } = useTranslation();
  const config = useCoreEconomyConfig();
  const save = useSaveCoreEconomy();
  // Где действует каждый рычаг — из каталогов CLI; списка ещё нет — строк отметок нет.
  const providers = useProviders().data?.providers ?? [];
  const support = (lever: GroupEconomyLever): ReactNode => (
    <GroupEconomySupport lever={lever} providers={providers} />
  );
  // Отказ прокладки (ядро не запущено, поднимается, не отвечает) — словами панели; прочее —
  // словами ядра дословно (P32).
  const reasonOf = (error: unknown): string => {
    const failure = failureOf(error);
    return failure.kind === 'refusal'
      ? t(`coreLaunch.failure.refusal.${failure.code}`)
      : failureReason(failure);
  };

  const heading = (
    <>
      <Typography variant="body" weight="medium">
        {t(`${P}.title`)}
      </Typography>
      <Typography variant="body-sm" color="subtle">
        {t(`${P}.hint`)}
      </Typography>
    </>
  );

  const view = config.data;
  if (!view) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)" data-core-economy="unavailable">
          {heading}
          {config.isError ? (
            <>
              <Typography variant="body-sm" color="danger" role="alert">
                {t(`${P}.unavailable`, { reason: reasonOf(config.error) })}
              </Typography>
              <div>
                <Button variant="secondary" size="sm" onClick={() => void config.refetch()}>
                  {t('settings.retry')}
                </Button>
              </div>
            </>
          ) : (
            <Typography variant="body-sm" color="subtle">
              {t('common.loading')}
            </Typography>
          )}
        </Stack>
      </Card>
    );
  }

  const economy = coreEconomyOf(view);
  const issue = coreEconomyIssue(view);
  const set = <K extends keyof CoreEconomyValues>(lever: K, value: CoreEconomyValues[K]): void =>
    save.mutate({ view, lever, value });

  // Значение по умолчанию помечено; чужое текущее (правка файла руками) не теряется.
  const numberOptions = (key: NumberLever, values: number[]) => {
    const [prefix, param, unit] = NUMBER_LABELS[key];
    const label = (value: number): string => {
      if (value === 0) return t(`${P}.${prefix}Off`);
      const amount = (value / unit).toLocaleString(i18n.language);
      return value === CORE_ECONOMY_SHOWN_DEFAULTS[key]
        ? t(`${P}.${prefix}Default`, { [param]: amount })
        : t(`${P}.${prefix}Value`, { [param]: amount });
    };
    const all = values.includes(economy[key]) ? values : [...values, economy[key]];
    return all.map((value) => ({ value: String(value), label: label(value) }));
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)" data-core-economy="ready">
        {heading}
        {issue ? (
          <Typography variant="body-sm" color="warning" role="status">
            {t(`${P}.issue`, { reason: issue })}
          </Typography>
        ) : null}

        <SelectField
          label={t(`${P}.compactWindow`)}
          value={String(economy.compactWindow)}
          onChange={(value) => set('compactWindow', Number(value))}
          options={numberOptions('compactWindow', WINDOW_VALUES)}
          hint={t(`${P}.compactWindowHint`)}
          disabled={save.isPending}
        />
        {support('compactWindow')}
        <SelectField
          label={t(`${P}.bashOutput`)}
          value={String(economy.bashOutputChars)}
          onChange={(value) => set('bashOutputChars', Number(value))}
          options={numberOptions('bashOutputChars', BASH_VALUES)}
          hint={t(`${P}.bashOutputHint`)}
          disabled={save.isPending}
        />
        {support('bashOutputChars')}
        <SelectField
          label={t(`${P}.readOutput`)}
          value={String(economy.readOutputTokens)}
          onChange={(value) => set('readOutputTokens', Number(value))}
          options={numberOptions('readOutputTokens', READ_VALUES)}
          hint={t(`${P}.readOutputHint`)}
          disabled={save.isPending}
        />
        {support('readOutputTokens')}
        <SelectField
          label={t(`${P}.cacheTtl`)}
          value={economy.cacheTtl}
          onChange={(value) => set('cacheTtl', value as CoreEconomyValues['cacheTtl'])}
          options={[
            { value: '', label: t(`${P}.cacheTtlAuto`) },
            { value: '5m', label: t(`${P}.cacheTtl5m`) },
            { value: '1h', label: t(`${P}.cacheTtl1h`) },
          ]}
          hint={t(`${P}.cacheTtlHint`)}
          disabled={save.isPending}
        />
        {support('cacheTtl')}
        <SettingToggleRow
          label={t(`${P}.detachIde`)}
          hint={t(`${P}.detachIdeHint`)}
          checked={economy.detachIde}
          onChange={(detachIde) => set('detachIde', detachIde)}
          disabled={save.isPending}
        />
        {support('detachIde')}
        <SettingToggleRow
          label={t(`${P}.workHabits`)}
          hint={t(`${P}.workHabitsHint`)}
          checked={economy.workHabits}
          onChange={(workHabits) => set('workHabits', workHabits)}
          disabled={save.isPending}
        />
        {support('workHabits')}
        {save.isError ? (
          <Typography variant="body-sm" color="danger" role="alert" data-core-economy-save="failed">
            {t(`${P}.saveFailed`, { reason: reasonOf(save.error) })}
          </Typography>
        ) : null}
      </Stack>
    </Card>
  );
}
