import type { GroupScenario } from '@claude-control/contracts';

export interface ScenarioFieldsProps {
  value: GroupScenario;
  onChange: (next: GroupScenario) => void;
}
