import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { DatePicker, todayIso } from '@shared/ui/date-picker';
import type { DateRangeValue } from '@shared/ui/date-picker';
import { DEFAULT_PERIOD, periodKey } from '@entities/Analytics';
import type { AnalyticsPreset } from '@entities/Analytics';
import { PRESETS } from './PeriodFilter.constants';
import { presetLabel } from './PeriodFilter.lib';
import type { PeriodFilterProps } from './PeriodFilter.types';
import styles from './PeriodFilter.module.scss';

/**
 * Период отчёта: быстрые кнопки, произвольный диапазон и сброс.
 *
 * Своего черновика дат здесь больше нет — календарь отдаёт обе границы сразу,
 * и состояние живёт в одном месте, в `value`. Раньше половина диапазона копилась
 * в локальном стейте и молча расходилась с показанным периодом.
 *
 * Одни сутки — законный выбор, а не незаконченный ввод: первый клик по календарю
 * даёт `from === to`, и отчёт строится за этот день.
 */
export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  const { t } = useTranslation();

  const isRange = value.kind === 'range';
  const range: DateRangeValue = isRange ? { from: value.from, to: value.to } : {};
  const isDefault = periodKey(value) === periodKey(DEFAULT_PERIOD);

  const changeRange = (next: DateRangeValue): void => {
    // Отметку с календаря сняли — фильтра по датам не осталось, и период
    // возвращается к значению по умолчанию: пустой отчёт показывать не за что.
    if (!next.from || !next.to) {
      onChange(DEFAULT_PERIOD);
      return;
    }
    onChange({ kind: 'range', from: next.from, to: next.to });
  };

  const choosePreset = (preset: AnalyticsPreset): void => {
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
        <DatePicker
          mode="range"
          value={range}
          onChange={changeRange}
          max={todayIso()}
          placeholder={t('analytics.rangePlaceholder')}
          ariaLabel={t('analytics.rangeLabel')}
          isActive={isRange}
          align="end"
        />
      </span>

      {/*
        Кнопка сброса не появляется и не исчезает, а гаснет: пропадающий элемент
        менял бы ширину ряда на каждое переключение периода, и фильтры прыгали бы
        ровно так же, как раньше прыгала вся страница.
      */}
      <Button
        size="sm"
        variant="ghost"
        disabled={isDefault}
        title={t('analytics.resetHint')}
        onClick={() => onChange(DEFAULT_PERIOD)}
      >
        {t('analytics.reset')}
      </Button>
    </Stack>
  );
}
