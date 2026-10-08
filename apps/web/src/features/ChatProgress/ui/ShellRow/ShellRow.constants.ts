import type { ShellView } from '../../model/progressView.types';

/**
 * Идёт — жёлтая с пульсом, готово — зелёная, упала или оборвана — красная,
 * остановлена самим агентом — серая: это его уборка, тревожить нечем.
 */
export const SHELL_TONE: Record<ShellView, 'danger' | 'success' | 'warning' | 'neutral'> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  stopped: 'danger',
  lost: 'danger',
  killed: 'neutral',
};
