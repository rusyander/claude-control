import type { PathStep } from '@agentdeck/contracts';
import { renumber } from './renumber';

export function removeStep(steps: PathStep[], id: string): PathStep[] {
  return renumber(steps.filter((step) => step.id !== id));
}
