import type { GroupCardProps } from '../ui/GroupCard/GroupCard.types';

export function statusTone(group: GroupCardProps['group']): 'success' | 'neutral' {
  return group.isRunning ? 'success' : 'neutral';
}
