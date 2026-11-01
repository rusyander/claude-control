import type { Scenario } from '@agentdeck/contracts/core/scenario';

export interface ScenarioViewProps {
  scenario: Scenario;
  /** Откуда сценарий: пресет из кода ядра или версия из библиотеки человека. */
  source: 'preset' | 'library';
}
