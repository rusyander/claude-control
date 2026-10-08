import type { ProgressAgent } from '@agentdeck/contracts';

/** Цвет точки субагента: упал — красный, закончил — зелёный, работает — жёлтый. */
export const AGENT_TONE: Record<ProgressAgent['status'], 'danger' | 'success' | 'warning'> = {
  failed: 'danger',
  done: 'success',
  running: 'warning',
};
