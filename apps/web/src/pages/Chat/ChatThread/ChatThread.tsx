import { useTranslation } from 'react-i18next';
import { agentRuns } from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { ChatLimitCard, panelResend, useLimitClears } from '@features/ChatLimitCard';
import { ChatMessages } from '@features/ChatMessages';
import { ChatEmptyState } from '../ChatEmptyState/ChatEmptyState';
import { answerChild } from '../lib/answerChild';
import { coreCardOf, decideCorePermit } from '../lib/corePermit';
import type { ChatThreadProps } from './ChatThread.types';

/**
 * Середина страницы чата: лента переписки, а пока говорить не о чем —
 * подсказки. Здесь же живут её обработчики: права своего агента и чужих,
 * ответы детям, повтор упавшего хода.
 */
export function ChatThread({
  messages,
  conversationId,
  liveConversationId,
  stream,
  modelName,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onEdit,
  onPickOption,
  isRunning,
  runStartedAt,
  localRun,
  chatId,
  coreTaskId,
  permissions,
  queued,
  onCancelQueued,
  child,
  onOpenChild,
  chats,
  activeRuns,
  childAnswerOptions,
  costUnit,
  effort,
  onContinue,
  onCompact,
  onFreshSession,
  onRefresh,
  handoff,
  isProjectContext,
  projectName,
  projectPath,
  onOpenEditor,
  onPickPrompt,
  mediaTopic,
  mediaRevision,
}: ChatThreadProps) {
  const { t } = useTranslation();
  // Ответ после сброса окна пришёл в историю (его шлёт ядро) — ошибка лимита прогона снимается.
  useLimitClears(
    stream,
    messages,
    coreTaskId,
    chatId ? () => agentRuns.dismissError(chatId) : undefined,
  );

  // Есть ли о чём говорить. Пустой разговор — это не только пустая история:
  // ход мог уже идти, ответ печататься или закончиться ошибкой, и подсказки
  // «с чего начать» поверх всего этого выглядели бы издевательством.
  const hasContent =
    messages.length > 0 || isLoading || isRunning || Boolean(stream.text) || Boolean(stream.error);

  if (!hasContent) {
    return (
      <ChatEmptyState
        isProjectContext={isProjectContext}
        projectName={projectName}
        projectPath={projectPath}
        onOpenEditor={onOpenEditor}
        onPick={onPickPrompt}
      />
    );
  }

  return (
    <ChatMessages
      messages={messages}
      conversationId={conversationId}
      stream={stream}
      modelName={modelName}
      isLoading={isLoading}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      onLoadMore={onLoadMore}
      onEdit={onEdit}
      onPickOption={onPickOption}
      isRunning={isRunning}
      runStartedAt={runStartedAt}
      localRun={localRun}
      permissions={permissions}
      queued={queued}
      onCancelQueued={onCancelQueued}
      onPermissionDecide={(toolUseId, behavior, message) => {
        // Вопрос права задачи ядра: ответ шлёт это окно командой ядра (сервер панели не вправе).
        // Номер чата ему не нужен — у хода ядра его может и не быть (сессию ведёт ядро).
        const core = coreCardOf(permissions, toolUseId);
        if (core) void decideCorePermit(core, behavior);
        else if (chatId) agentRuns.decidePermission(chatId, toolUseId, behavior, message);
      }}
      childStages={child.stages}
      onOpenChild={onOpenChild}
      childTree={child.tree}
      onPauseTree={child.pauseAll}
      onResumeTree={child.resumeAll}
      treeBusy={child.treeBusy}
      childPermissions={child.permissions}
      // Решение по правам ребёнка уходит в ЕГО прогон — тем же путём, что и
      // своё: брокер ждёт ответа по ключу прогона, и родительский разговор об
      // этом не узнаёт вовсе. Вопрос права задачи ядра у ребёнка — командой ядра из окна, как свой.
      onChildPermissionDecide={(childId, toolUseId, behavior) => {
        const core = coreCardOf(
          child.permissions.flatMap((c) => c.permissions),
          toolUseId,
        );
        if (core) void decideCorePermit(core, behavior);
        else agentRuns.decidePermission(childId, toolUseId, behavior);
      }}
      childQuestions={child.questions}
      // Ответ уходит в ЧАТ РЕБЁНКА обычным сообщением: другого канала нет —
      // вызов `AskUserQuestion` в пакетном режиме возвращается ошибкой сразу и
      // никого не ждёт. Ребёнок ещё работает — ответ встаёт в его очередь и
      // уйдёт по концу хода. Родительский разговор при этом не трогается: ни
      // хода, ни строки в его ленте.
      onChildAnswer={(childId, answer) =>
        answerChild(childId, answer, {
          chats,
          runs: activeRuns,
          options: childAnswerOptions,
          // Ответ ребёнку не оставляет следа в этой ленте — намеренно, ход
          // тратит он. След нужен человеку: тост называет разговор, в который
          // ушёл выбор, иначе после шести ответов подряд не вспомнить, кому
          // именно ответил.
          notify: (title, wasQueued) =>
            toast.success(
              t(wasQueued ? 'chat.answerQueuedForChild' : 'chat.answerSentToChild', { title }),
            ),
          onRefused: (title, message) =>
            toast.error(t('chat.answerRefusedForChild', { title, message })),
        })
      }
      // Лимит держит ход — повтор ведёт ядро (P171): повтор панели дал бы второй ход того же слова.
      onRetry={panelResend(stream, chatId ? () => agentRuns.retry(chatId) : undefined)}
      onContinue={panelResend(stream, chatId ? onContinue : undefined)}
      onDismissError={chatId ? () => agentRuns.dismissError(chatId) : undefined}
      onCompact={chatId ? onCompact : undefined}
      onFreshSession={chatId ? onFreshSession : undefined}
      errorAside={
        <ChatLimitCard
          // Новый лимит — новая карточка: «Ждать сброса» прошлого не сворачивает этот.
          key={stream.error ?? ''}
          stream={stream}
          {...(coreTaskId ? { coreTaskId } : {})}
          {...(liveConversationId ? { conversationId: liveConversationId } : {})}
        />
      }
      onRefresh={onRefresh}
      onKeepSession={chatId ? () => void agentRuns.keepSession(chatId) : undefined}
      costUnit={costUnit}
      // Кто рисовал и диктовал в карточке вложения (Т10): модель разговора
      // известна здесь, а второго её источника в ленте нет.
      mediaModel={childAnswerOptions.model}
      // Тема человека и правка колоды: состояние держит композер страницы, а
      // карточка в ленте — единственное место, откуда правку начинают у Claude
      // для колоды, приехавшей блоком.
      {...(mediaTopic ? { mediaTopic } : {})}
      {...(mediaRevision ? { mediaRevision } : {})}
      effort={effort}
      handoff={handoff}
    />
  );
}
