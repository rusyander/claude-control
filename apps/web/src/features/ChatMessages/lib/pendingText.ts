import type { ChildStageGroup } from '../ui/ChildStages.types';
import type { TFunction } from 'i18next';
import { serverFieldText } from '@shared/config/i18n';

/** Чего ждёт группа без чата — словами, которые человек может проверить по сводке. */
export function pendingText(group: ChildStageGroup, t: TFunction): string {
  switch (group.pending) {
    case 'failed':
      return t('chat.cascade.hub.failed', { message: serverFieldText(group, 'error') });
    case 'held':
      return t('chat.cascade.hub.held');
    case 'queued':
      return t('chat.cascade.hub.queued');
    case 'setup':
      return t('chat.cascade.hub.setup');
    case 'paused':
      return t('chat.cascade.hub.pausedNoChat');
    case 'interrupted':
      return t('chat.cascade.hub.interruptedNoChat');
    case 'waiting': {
      const waiting = t('chat.cascade.hub.waiting', { names: (group.waitsFor ?? []).join(', ') });
      return group.holdAnswered ? `${t('chat.cascade.hub.holdAnswered')} · ${waiting}` : waiting;
    }
    default:
      return t('chat.cascade.hub.pending');
  }
}
