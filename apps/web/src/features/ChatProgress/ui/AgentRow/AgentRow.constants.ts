import type { AgentView } from '../../model/progressView.types';

/**
 * Цвет точки субагента: упал — красный, закончил — зелёный, работает — жёлтый,
 * умер вместе с процессом разговора — красный: итога не будет. Остановленный по
 * просьбе — серый: это решение человека или агента, а не беда.
 */
export const AGENT_TONE: Record<AgentView, 'danger' | 'success' | 'warning' | 'neutral'> = {
  failed: 'danger',
  done: 'success',
  running: 'warning',
  lost: 'danger',
  stopped: 'neutral',
};
