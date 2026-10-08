import { useT } from '../../shared/config/i18n';

export function noticeLabel(status: string, t: ReturnType<typeof useT>): string {
  if (status === 'completed') return t.chat.taskNotice.completed;
  if (status === 'failed') return t.chat.taskNotice.failed;
  if (status === 'killed') return t.chat.taskNotice.killed;
  return t.chat.taskNotice.other;
}
