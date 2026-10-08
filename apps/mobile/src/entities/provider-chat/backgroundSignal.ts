import type { ProviderChatStatus } from '@agentdeck/contracts';
import type { BackgroundSignal } from './model.types';

export function backgroundSignal(
  previous: ProviderChatStatus | undefined,
  next: ProviderChatStatus | undefined,
): BackgroundSignal | undefined {
  if (!previous || !next) return undefined;
  if ((next.permissions?.length ?? 0) > (previous.permissions?.length ?? 0)) return 'permission';
  if (previous.isRunning && !next.isRunning) return 'finished';
  return undefined;
}
