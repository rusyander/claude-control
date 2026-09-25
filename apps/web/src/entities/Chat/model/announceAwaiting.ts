import type { TFunction } from 'i18next';
import type { ChatSummary } from '@agentdeck/contracts';
import { notifyAgent } from '@shared/lib/notify-sound';
import { showSystemNotice } from '@shared/lib/system-notify';
import { toast } from '@shared/lib/toast';
import { projectShortName } from '@shared/lib/workspace';

/**
 * Позвать человека к разговорам, которые только что встали на вопрос: тост с
 * переходом в проект, звук и — на скрытой вкладке — уведомление системы.
 *
 * Уведомление здесь обязательно: вопрос группы разделения приходит, пока
 * человек сидит в другой вкладке, а тост и звук там не видны (находка 77
 * живого прогона 24.09). Тег по чату: повторный повод того же разговора
 * заменяет уведомление, а не копит стопку.
 */
export function announceAwaiting(
  fresh: readonly ChatSummary[],
  { t, reveal }: { t: TFunction; reveal: (path: string, name: string) => void },
): void {
  if (fresh.length === 0) return;
  for (const chat of fresh) {
    const path = chat.isSandbox ? undefined : chat.projectPath;
    const name = path ? projectShortName(path) : t('workspace.homeTab');
    const open = path ? () => reveal(path, name) : undefined;
    const body = t('projects.notifyWaiting', { name });
    toast.warning(body, { onClick: open });
    showSystemNotice({
      title: t('common.appName'),
      body,
      tag: `awaiting:${chat.id}`,
      ...(open ? { onClick: open } : {}),
    });
  }
  // Звук один на пачку: пять вопросов разом — это один повод подойти.
  notifyAgent('waiting');
}
