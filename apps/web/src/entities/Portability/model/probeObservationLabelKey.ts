import type { ProbeObservation } from '@agentdeck/contracts/portable-probe';

export function probeObservationLabelKey(observation: ProbeObservation): string {
  return `portability.probe.observation.${observation}`;
}
