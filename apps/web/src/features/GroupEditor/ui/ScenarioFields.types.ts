import type { GroupScenario } from '@agentdeck/contracts';

export interface ScenarioFieldsProps {
  value: GroupScenario;
  onChange: (next: GroupScenario) => void;
}
