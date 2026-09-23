import { useTranslation } from 'react-i18next';
import { agentRuns } from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { ChatMessages } from '@features/ChatMessages';
import { ChatEmptyState } from './ChatEmptyState';
import { answerChild } from './lib/answerChild';
import type { ChatThreadProps } from './ChatThread.types';

/**
 * Середина страницы чата: лента переписки, а пока говорить не о чем —
 * подсказки. Здесь же живут её обработчики: права своего агента и чужих,
 * ответы детям, повтор упавшего хода.
 */
export function ChatThread({
  messages,
  conversationId,
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
  chatId,
  permissions,
  branchGates,
  queued,
  onCancelQueued,
  child,
  onOpenChild,
  chats,
  activeRuns,
  childAnswerOptions,
  costUnit,
  effort,
  taskSplit,
  onContinue,
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
      permissions={permissions}
      branchGates={branchGates}
      queued={queued}
      onCancelQueued={onCancelQueued}
      onPermissionDecide={(toolUseId, behavior, message) =>
        chatId && agentRuns.decidePermission(chatId, toolUseId, behavior, message)
      }
      onBranchDecide={(toolUseId, choice, branch) =>
        chatId
          ? agentRuns.decideBranchGate(chatId, toolUseId, choice, branch)
          : Promise.resolve({ ok: false })
      }
      childStages={child.stages}
      onOpenChild={onOpenChild}
      childTree={child.tree}
      onPauseTree={child.pauseAll}
      onResumeTree={child.resumeAll}
      treeBusy={child.treeBusy}
      onAnswerHold={child.answerHold}
      holdBusy={child.holdBusy}
      onRelease={child.release}
      releaseBusy={child.releaseBusy}
      onCheckOverlap={child.checkOverlap}
      overlapBusy={child.overlapBusy}
      // Ревью чужих MR (Т7): в родителе — карточки всех групп, в самой группе —
      // её собственная. Решение оттуда и отсюда одно и то же: состояние живёт в
      // связи чата, а не во вкладке.
      reviews={child.reviews}
      onReviewDecide={child.reviewDecide}
      onReviewPush={child.reviewPush}
      onReviewRetry={child.reviewRetry}
      reviewBusy={child.reviewBusy}
      childPermissions={child.permissions}
      // Решение по правам ребёнка уходит в ЕГО прогон — тем же путём, что и
      // своё: брокер ждёт ответа по ключу прогона, и родительский разговор об
      // этом не узнаёт вовсе.
      onChildPermissionDecide={(childId, toolUseId, behavior) =>
        agentRuns.decidePermission(childId, toolUseId, behavior)
      }
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
        })
      }
      onRetry={chatId ? () => agentRuns.retry(chatId) : undefined}
      onContinue={chatId ? onContinue : undefined}
      onRefresh={onRefresh}
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
      onSplit={taskSplit.split}
      onKeepHere={taskSplit.keepHere}
      isSplitPending={taskSplit.isPending}
      // Потолок разговора: карточка предложения показывает по нему класс,
      // модель и глубину каждой группы — тем же расчётом, каким сервер их и
      // назначит. Пусто — подбор в проекте выключен, и про модели она молчит.
      splitCeiling={taskSplit.ceiling}
      // Ветки уже заведённых детей — по ним карточка предложения понимает, что
      // разделение состоялось, и убирает кнопку.
      childBranches={child.branches}
      handoff={handoff}
    />
  );
}
