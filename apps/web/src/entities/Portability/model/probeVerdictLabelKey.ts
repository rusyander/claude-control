import type { ProbeVerdict } from '@agentdeck/contracts/portable-probe';

export function probeVerdictLabelKey(verdict: ProbeVerdict): string {
  return `portability.probe.verdict.${verdict}`;
}
