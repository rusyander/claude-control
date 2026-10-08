import type { ProgressShell } from '@agentdeck/contracts';
import type { ShellView } from './progressView.types';

export function shellView(
  shell: ProgressShell,
  isRunning: boolean,
  processAlive: boolean | undefined = undefined,
): ShellView {
  const alive = processAlive ?? isRunning;
  if (shell.status === 'running' && !alive && !isRunning) return 'lost';
  return shell.status;
}
