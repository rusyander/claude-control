import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import type { AnalyticsPreset } from '@entities/Analytics';
import { PRESETS } from './PeriodFilter.constants';
import { isoDay, presetLabel } from './PeriodFilter.lib';
import type { PeriodFilterProps } from './PeriodFilter.types';
import styles from './PeriodFilter.module.scss';

/**
 * Период отчёта: быстрые кнопки и произвольный диапазон.
 *
 * Диапазон применяется, только когда заполнены обе даты: по одной границе
 * непонятно, что показывать, а перезапрашивать тяжёлую аналитику на каждый
 * промежуточный ввод — секунды обхода транскриптов впустую.
 */
export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() =>
    value.kind === 'range' ? { from: value.from, to: value.to } : { from: '', to: '' },
  );

  const isRange = value.kind === 'range';
  const today = isoDay(new Date());

  const changeBound = (bound: 'from' | 'to', date: string): void => {
    const next = { ...draft, [bound]: date };
    setDraft(next);
    if (next.from && next.to) onChange({ kind: 'range', from: next.from, to: next.to });
  };

  const choosePreset = (preset: AnalyticsPreset): void => {
    // Кнопка обнуляет диапазон: иначе поля дат остались бы заполненными и
    // противоречили выбранному пресету.
    setDraft({ from: '', to: '' });
    onChange({ kind: 'preset', preset });
  };

  return (
    <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
      {PRESETS.map((preset) => (
        <Button
          key={preset}
          size="sm"
          variant={!isRange && value.preset === preset ? 'primary' : 'secondary'}
          onClick={() => choosePreset(preset)}
        >
          {t(presetLabel(preset))}
        </Button>
      ))}

      <span className={styles.range}>
        <input
          type="date"
          className={styles.input}
          value={draft.from}
          max={draft.to || today}
          aria-label={t('analytics.rangeFrom')}
          title={t('analytics.rangeFrom')}
          data-active={isRange}
          onChange={(event) => changeBound('from', event.target.value)}
        />
        <span aria-hidden="true">—</span>
        <input
          type="date"
          className={styles.input}
          value={draft.to}
          min={draft.from || undefined}
          max={today}
          aria-label={t('analytics.rangeTo')}
          title={t('analytics.rangeTo')}
          data-active={isRange}
          onChange={(event) => changeBound('to', event.target.value)}
        />
      </span>
    </Stack>
  );
}
