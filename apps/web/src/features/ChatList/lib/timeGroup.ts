import type { TimeGroup } from '../ui/ChatList/ChatList.types';

export function timeGroup(iso: string): TimeGroup {
  const date = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (date.getTime() >= startOfToday.getTime()) return 'today';

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date.getTime() >= startOfYesterday.getTime()) return 'yesterday';

  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 7);
  return date.getTime() >= weekAgo.getTime() ? 'thisWeek' : 'earlier';
}
