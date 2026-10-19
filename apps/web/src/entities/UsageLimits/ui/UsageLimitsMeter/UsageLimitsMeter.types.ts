import type { UsageLimits } from '@agentdeck/contracts';

export interface UsageLimitsMeterProps {
  /** Свёрнутая боковая панель: рейка шириной в значок, только проценты. */
  isCollapsed?: boolean;
}

export interface UsageLimitsViewProps extends UsageLimitsMeterProps {
  limits: UsageLimits;
  /** Сейчас, мс эпохи — параметром, чтобы вид не зависел от часов в тесте. */
  now: number;
}
