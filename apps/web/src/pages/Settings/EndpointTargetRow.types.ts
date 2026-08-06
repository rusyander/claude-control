import type { EndpointTarget } from '@claude-control/contracts';

export interface EndpointTargetRowProps {
  target: EndpointTarget;
  /** Профиль ещё не заполнен (нет корректного адреса) — применять нечего. */
  disabled: boolean;
  isApplying: boolean;
  onApply: (providerId: string) => void;
}
