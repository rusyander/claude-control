import type { AnalyticsPeriod } from '@entities/Analytics';

export interface PeriodFilterProps {
  value: AnalyticsPeriod;
  onChange: (period: AnalyticsPeriod) => void;
}
