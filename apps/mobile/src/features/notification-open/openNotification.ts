import { coreAskTarget } from '../../entities/core-task/model';
import { notificationTarget } from '../../entities/provider-chat/model';

/** Что нужно переходу из уведомления — настоящие `router`, `openChat`, выбор панели в `_layout.tsx`. */
export interface NotificationOpenDeps {
  /** Панель машины, приславшей уведомление (`machineId` в данных), или `undefined` — текущая. */
  panelForMachine: (machineId: unknown) => unknown;
  activatePanel: (panel: never) => Promise<void>;
  push: (href: string | { pathname: string; params: Record<string, string> }) => void;
  openChat: (chatId: string, projectPath?: string) => void;
}

/**
 * Нажатие на уведомление — туда, о чём оно: чужой CLI открывается своим экраном, разговор Claude —
 * обычным чатом своего проекта. Уведомление с другого компьютера сначала выбирает его: разговор живёт
 * на той машине.
 */
export async function openNotification(data: unknown, deps: NotificationOpenDeps): Promise<void> {
  // Вопрос ядра — экран задачи с этим вопросом первым (ответ подписывается ключом телефона).
  const core = coreAskTarget(data);
  const target = core ? undefined : notificationTarget(data);
  if (!core && !target) return;
  const panel = deps.panelForMachine((data as { machineId?: unknown } | null)?.machineId);
  if (panel) await deps.activatePanel(panel as never);
  if (core) {
    deps.push({
      pathname: '/core-task',
      params: { id: core.taskId, ...(core.askId ? { ask: core.askId } : {}) },
    });
    return;
  }
  if (!target) return;
  if (target.kind === 'foreign') {
    deps.push({
      pathname: '/foreign-chat',
      params: { provider: target.providerId, id: target.chatId },
    });
    return;
  }
  deps.openChat(target.chatId, target.projectPath || undefined);
  deps.push('/chat');
}
