import type { UsageLimitsTexts } from './ru';

export const usageLimitsEn: UsageLimitsTexts = {
  session: 'Session',
  weekly: 'Week',
  weeklyModel: (model: string) => `Week · ${model}`,
  untilDays: (d: number, h: number) => `${d}d ${h}h`,
  untilHours: (h: number, m: number) => `${h}h ${m}m`,
  untilMinutes: (m: number) => `${m}m`,
  untilSoon: 'now',
  resetIn: (until: string) => `resets in ${until}`,
  a11y: (label: string, percent: string, until: string | null) =>
    until ? `${label}: ${percent} used, ${until}` : `${label}: ${percent} used`,
  stale: 'not updated',
};
