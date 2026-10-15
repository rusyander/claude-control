import type { AgentView } from '../../model/progressView.types';

/**
 * Цвет точки субагента: упал — красный, закончил — зелёный, работает — жёлтый,
 * умер вместе с процессом разговора — красный: итога не будет.
 */
export const AGENT_TONE: Record<AgentView, 'danger' | 'success' | 'warning'> = {
  failed: 'danger',
  done: 'success',
  running: 'warning',
  lost: 'danger',
};
