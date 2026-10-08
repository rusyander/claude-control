import type { GroupCardProps } from '../ui/GroupCard/GroupCard.types';
import { isMrSettled } from './isMrSettled';

export function statusTone(group: GroupCardProps['group']): 'success' | 'danger' | 'neutral' {
  if (isMrSettled(group)) return group.mrClosed === 'merged' ? 'success' : 'neutral';
  if (group.chatId) return group.isRunning ? 'success' : 'neutral';
  return group.pending === 'failed' ? 'danger' : 'neutral';
}
