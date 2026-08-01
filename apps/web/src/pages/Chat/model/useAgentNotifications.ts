import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspace, projectShortName } from '@shared/lib/workspace';
import { agentRuns, type RunStatus } from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { notifyAgent, type NotifyKind } from '@shared/lib/notify-sound';
import { dismissAttention } from '@shared/lib/attention';

/** Каким звуком зовёт завершившийся фоновый прогон: упал, спросил или просто закончил. */
const BACKGROUND_SOUND: Record<RunStatus, NotifyKind> = {
  error: 'error',
  waiting: 'waiting',
  running: 'done',
  idle: 'done',
};

export interface AgentNotificationsInput {
  /** Разговор, открытый прямо сейчас: его собственные события не тостуем. */
  chatId?: string;
  /** Стабильный id прогона активного чата и его статус. */
  runId: string;
  runStatus: RunStatus;
}

/**
 * Как панель зовёт человека к агенту: тосты и звук про фоновые прогоны, звук
 * про свой, снятие метки в браузере по факту увиденного. Ничего не рисует —
 * только подписки на стор прогонов.
 */
export function useAgentNotifications({ chatId, runId, runStatus }: AgentNotificationsInput): void {
  const { t } = useTranslation();
  const ws = useWorkspace();

  // Фоновый агент в другом проекте задал вопрос, завершил или упал — сообщаем
  // тостом. Так за несколькими агентами видно из одного места.
  useEffect(() => {
    agentRuns.setOnBackgroundEvent((backgroundRun) => {
      const path = backgroundRun.projectPath;
      const name = path ? projectShortName(path) : t('workspace.homeTab');
      // Клик по тосту открывает тот проект — сразу видно, к кому идти.
      const options = path ? { onClick: () => ws.openProject(path, name) } : undefined;
      if (backgroundRun.status === 'waiting')
        toast.warning(t('projects.notifyWaiting', { name }), options);
      else if (backgroundRun.status === 'error')
        toast.error(t('projects.notifyError', { name }), options);
      else toast.success(t('projects.notifyDone', { name }), options);

      // Звук уведомления — чтобы услышать другого агента, не глядя в экран.
      notifyAgent(BACKGROUND_SOUND[backgroundRun.status]);
    });
    return () => agentRuns.setOnBackgroundEvent(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Агент попросил разрешение (интерактивные права) — звук всегда, а для агента
  // из другого проекта ещё и тост с переходом: работа стоит, пока не ответишь.
  useEffect(() => {
    agentRuns.setOnPermissionRequest((permissionRun) => {
      const isActive = permissionRun.id === chatId || permissionRun.sessionId === chatId;
      if (!isActive) {
        const path = permissionRun.projectPath;
        const name = path ? projectShortName(path) : t('workspace.homeTab');
        const options = path ? { onClick: () => ws.openProject(path, name) } : undefined;
        toast.warning(t('projects.notifyPermission', { name }), options);
      }
      notifyAgent('waiting');
    });
    return () => agentRuns.setOnPermissionRequest(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, chatId]);

  // Агент, за которым сейчас смотрим, задал вопрос или упал — тоже звук, чтобы
  // не пропустить момент, когда от тебя ждут ответа. Только переход из «работает»,
  // чтобы открытие уже ждущего чата не пищало.
  const prevStatusRef = useRef(runStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = runStatus;
    if (prev !== 'running') return;
    if (runStatus === 'waiting' || runStatus === 'error') notifyAgent(runStatus);
  }, [runStatus]);

  // Метка в браузере гаснет по действию человека, а не по таймеру: открыт тот
  // самый чат и окно активно — значит, повод увиден. Слушаем возврат фокуса и
  // возврат на вкладку: пришёл на зов из другой программы — метка снимается.
  useEffect(() => {
    const attentionId = runId || chatId;
    if (!attentionId) return;
    if (runStatus !== 'waiting' && runStatus !== 'error') return;

    const seen = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        dismissAttention(attentionId, runStatus);
      }
    };
    seen();
    window.addEventListener('focus', seen);
    document.addEventListener('visibilitychange', seen);
    return () => {
      window.removeEventListener('focus', seen);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [runId, runStatus, chatId]);
}
