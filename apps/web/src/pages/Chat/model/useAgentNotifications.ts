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
  // Молчание — не событие: сюда оно не доходит, а звук у него тот же, что у работы.
  quiet: 'done',
  idle: 'done',
};

export interface AgentNotificationsInput {
  /** Разговор, открытый прямо сейчас: его собственные события не тостуем. */
  chatId?: string;
  /**
   * ДОЧЕРНИЕ разговоры открытого чата — те, что выделило разделение задач, с их
   * названиями. Их вопросы показываются прямо здесь, в родителе, поэтому звать
   * тостом «сходите в другой проект» некуда: человек уже смотрит туда, где
   * стоит карточка. Звук остаётся — он про «от вас чего-то ждут», а не про то,
   * куда идти. Название нужно самим тостам: у ребёнка «проект» — это копия
   * репозитория, и звать по имени ветки вместо имени разговора значит называть
   * не то, что человек видит в списке.
   */
  children?: { id: string; title: string }[];
  /**
   * Открыть дочерний разговор ЗДЕСЬ же, в этой вкладке. Тост про ребёнка иначе
   * уводил бы в отдельный проект: его каталог — копия репозитория, и открытие
   * вернуло бы ряд одинаковых вкладок, от которого разделение как раз уходит.
   */
  onOpenChild?: (chatId: string) => void;
  /** Стабильный id прогона активного чата и его статус. */
  runId: string;
  runStatus: RunStatus;
}

/**
 * Как панель зовёт человека к агенту: тосты и звук про фоновые прогоны, звук
 * про свой, снятие метки в браузере по факту увиденного. Ничего не рисует —
 * только подписки на стор прогонов.
 */
export function useAgentNotifications({
  chatId,
  children,
  onOpenChild,
  runId,
  runStatus,
}: AgentNotificationsInput): void {
  const { t } = useTranslation();
  const ws = useWorkspace();
  // Подписки переустанавливать по составу детей, а не по массиву: он
  // пересобирается на каждом рендере родителя.
  const childKeys = (children ?? []).map((child) => `${child.id}\u0000${child.title}`).join(',');

  // Фоновый агент в другом проекте задал вопрос, завершил или упал — сообщаем
  // тостом. Так за несколькими агентами видно из одного места.
  useEffect(() => {
    agentRuns.setOnBackgroundEvent((backgroundRun) => {
      const path = backgroundRun.projectPath;
      const name = path ? projectShortName(path) : t('workspace.homeTab');
      // Ребёнок открытого чата — особый случай на оба лада. Его вопрос уже
      // показан здесь карточкой, поэтому «ждёт ответа» тостом не зовём вовсе:
      // звать некуда. А «упал» и «закончил» карточки не имеют — их говорим, но
      // называем разговором и открываем В ЭТОЙ вкладке, а не проектом: каталог
      // ребёнка — копия репозитория, и переход завёл бы ту самую лишнюю
      // вкладку, от которой разделение уходит. Звук остаётся всегда.
      const child = (children ?? []).find(
        (item) => item.id === backgroundRun.id || item.id === backgroundRun.sessionId,
      );
      const options = child
        ? onOpenChild && { onClick: () => onOpenChild(child.id) }
        : path && { onClick: () => ws.reveal(path, name) };

      if (child) {
        if (backgroundRun.status === 'error')
          toast.error(t('projects.notifyChildError', { title: child.title }), options || undefined);
        else if (backgroundRun.status !== 'waiting')
          toast.success(
            t('projects.notifyChildDone', { title: child.title }),
            options || undefined,
          );
      } else if (backgroundRun.status === 'waiting')
        toast.warning(t('projects.notifyWaiting', { name }), options || undefined);
      else if (backgroundRun.status === 'error')
        toast.error(t('projects.notifyError', { name }), options || undefined);
      else toast.success(t('projects.notifyDone', { name }), options || undefined);

      // Звук уведомления — чтобы услышать другого агента, не глядя в экран.
      notifyAgent(BACKGROUND_SOUND[backgroundRun.status]);
    });
    return () => agentRuns.setOnBackgroundEvent(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, childKeys]);

  // Агент попросил разрешение (интерактивные права) — звук всегда, а для агента
  // из другого проекта ещё и тост с переходом: работа стоит, пока не ответишь.
  useEffect(() => {
    agentRuns.setOnPermissionRequest((permissionRun) => {
      const keys = [permissionRun.id, permissionRun.sessionId].filter(Boolean);
      // Свой вопрос и вопрос ребёнка открытого чата — оба уже на экране.
      const isHere =
        keys.includes(chatId) ||
        (children ?? []).some((child) => keys.includes(child.id as string | undefined));
      if (!isHere) {
        const path = permissionRun.projectPath;
        const name = path ? projectShortName(path) : t('workspace.homeTab');
        const options = path ? { onClick: () => ws.reveal(path, name) } : undefined;
        toast.warning(t('projects.notifyPermission', { name }), options);
      }
      notifyAgent('waiting');
    });
    return () => agentRuns.setOnPermissionRequest(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, chatId, childKeys]);

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
