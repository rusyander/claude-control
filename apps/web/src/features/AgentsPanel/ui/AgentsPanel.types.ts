import type { ActiveRunView } from '@shared/lib/agent-runs';

export interface AgentsPanelProps {
  activeRuns: ActiveRunView[];
  /** Накопленная стоимость всех прогонов, USD. */
  totalCost: number;
  /** Накопленные токены всех прогонов. */
  totalTokens: number;
  /** В каких единицах показывать расход. */
  costUnit: 'tokens' | 'money';
  onStop: (id: string) => void;
  onStopAll: () => void;
  /** Открыть прогон в главном чате — видеть, что агент делает. */
  onView: (run: ActiveRunView) => void;
}
