import type { TaskNotice } from './taskNotice';
import { useT } from '../../shared/config/i18n';
import { noticeLabel } from './noticeLabel';

export function noticeLine(notice: TaskNotice, t: ReturnType<typeof useT>): string {
  const mark = notice.status === 'completed' ? '✓' : '!';
  const summary = notice.summary ? ` · ${notice.summary}` : '';
  return `${mark} ${noticeLabel(notice.status, t)}${summary}`;
}
