import type { PlatformCapabilityFinding } from '@agentdeck/contracts';

export interface CapabilityMatrixProps {
  /** Строки в порядке ответа сервера: своего порядка у клиента нет. */
  findings: PlatformCapabilityFinding[];
}
