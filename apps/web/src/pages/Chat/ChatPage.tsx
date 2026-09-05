import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspace } from '@shared/lib/workspace';
import { isStreamShown } from '@shared/lib/chat-stream';
import {
  agentRuns,
  useAgentRun,
  useActiveRuns,
  useTotalCost,
  useTotalTokens,
} from '@shared/lib/agent-runs';
import { useChatPrefs } from '@shared/lib/chat-prefs';
import { useDraft } from '@shared/lib/draft';
import { WorkspaceTabs } from '@features/WorkspaceTabs';
import { AssistantKeyGate } from '@features/AssistantKeyGate';
import {
  useChats,
  useChatMessages,
  useChatAutoRefresh,
  useChatProgress,
  CHAT_PAGE_SIZE,
} from '@entities/Chat';
import { useProjects, useOpenInEditor } from '@entities/Project';
import { useSettings } from '@entities/AppConfig';
import { useModelCatalog } from '@entities/ModelCatalog';
import { ChatSidebar } from './ChatSidebar';
import { ChatHeader } from './ChatHeader';
import { ChatArtifactsBar } from './ChatArtifactsBar';
import { ChatThread } from './ChatThread';
import { ChatOverlays } from './ChatOverlays';
import { ChatDock } from './ChatDock';
import { ChatPreviewPane } from './ChatPreviewPane';
import { useChatSession } from './model/useChatSession';
import { useChatSend } from './model/useChatSend';
import { useChatArtifacts } from './model/useChatArtifacts';
import { useParallelLaunch } from './model/useParallelLaunch';
import { useTaskSplit } from './model/useTaskSplit';
import { useChatHandoff } from './model/useChatHandoff';
import { useRunLifecycle } from './model/useRunLifecycle';
import { useQueuedAsPending } from './model/useQueuedAsPending';
import { useAgentNotifications } from './model/useAgentNotifications';
import { usePreviewWidth } from './model/usePreviewWidth';
import { visibleChats } from './lib/visibleChats';
import { useChildHub } from './model/useChildHub';
import { useChatDots } from './model/useChatDots';
import { useChatModelPrefs } from './model/useChatModelPrefs';
import { useStreamState } from './model/useStreamState';
import { downloadChatExport } from './lib/downloadChatExport';
import { keepPending } from './lib/pending';
import { withoutLiveTurn } from './lib/liveTurn';
import styles from './ChatPage.module.scss';

/**
 * Полноценный чат с Claude Code. Переписку хранит сам Claude Code в своих
 * транскриптах, поэтому здесь нет отдельной базы: список читается из них,
 * а продолжение разговора идёт через тот же механизм сессий, что и в терминале.
 *
 * Сверху — лента табов рабочего пространства: домашний чат и открытые проекты.
 * Прогоны идут через общий стор `agent-runs`: агент в проекте продолжает
 * работать в фоне, даже когда ты ушёл на другой таб, а цветные точки на табах
 * показывают, где он работает, где ждёт ответа и где случилась беда.
 */
export function ChatPage() {
  const { t } = useTranslation();

  const [previewWidth, resizePreview] = usePreviewWidth();
  // Тумблер прав хранится в chatPrefs (localStorage): по умолчанию правки
  // разрешены и не слетают после перезагрузки.
  const { allowEdits, setAllowEdits, autoApprove, setAutoApprove } = useChatPrefs();
  const [isFolderPickerOpen, setFolderPickerOpen] = useState(false);
  const [isCodeOpen, setCodeOpen] = useState(false);
  const [isTestsOpen, setTestsOpen] = useState(false);
  const openEditor = useOpenInEditor();
  const { data: settings } = useSettings();
  const { data: modelCatalog } = useModelCatalog();
  const costUnit = settings?.costUnit ?? 'tokens';

  const chats = useChats();
  const projects = useProjects();
  const ws = useWorkspace();
  // Цветные точки по разговорам и проектам — живые прогоны плюс те, что стоят
  // на вопросе мимо панели (подробности и почему их два источника — в хуке).
  const { chatStatuses, projectStatuses } = useChatDots();
  const activeRuns = useActiveRuns();
  const spend = { cost: useTotalCost(), tokens: useTotalTokens() };

  // Какой разговор открыт, в каком каталоге он идёт и как между разговорами
  // ходят: всё это живёт в одном месте — здесь только читаем.
  const session = useChatSession({ chats: chats.data });
  const { activeChat, chatId, projectPath, isProjectContext, draftKey, preview, pending } = session;

  const run = useAgentRun(chatId);
  // Досланное из очереди сразу встаёт в ленту своим пузырём (см. хук).
  useQueuedAsPending(run.sentFromQueue, session.setPending);
  const isRunning = run.status === 'running';
  const stream = useStreamState(run, isRunning);

  const [input, setInput] = useDraft(draftKey);

  // Модель и глубина продумывания: общий дефолт из настроек плюс выбор этого
  // разговора (подробности — в хуке).
  const models = useChatModelPrefs(draftKey, settings);

  const shownChats = useMemo(
    () => visibleChats(chats.data ?? [], ws.activeProject?.id),
    [chats.data, ws.activeProject],
  );

  // Родительский чат как пульт над детьми разделения: их вопросы, их запросы
  // прав и они сами — по именам (подробности и почему именно так — в хуке).
  const child = useChildHub(chats.data, activeChat?.id, activeRuns);

  // Размер окна ленты. Растёт кнопкой «Загрузить ещё»: каждый шаг подтягивает
  // более ранние сообщения. При смене разговора возвращаемся к последнему окну.
  const [messagesLimit, setMessagesLimit] = useState(CHAT_PAGE_SIZE);
  useEffect(() => {
    setMessagesLimit(CHAT_PAGE_SIZE);
  }, [activeChat?.id]);

  const messages = useChatMessages(activeChat?.id, messagesLimit);
  const messageList = messages.data?.messages ?? [];
  // Пока потоковый пузырь на экране, текущий ход агента рисует он один: из
  // истории такой ход убираем, иначе перечитка ленты посреди прогона
  // показывает те же вызовы дважды — по разу из каждого источника.
  const streamShown = isStreamShown(stream);
  const shownHistory = withoutLiveTurn(messageList, run.startedAt, streamShown);
  // Разговор мог продолжиться мимо панели — из терминала или расширения
  // редактора. Такой ход не даёт потока событий, и лента жила бы снимком на
  // момент открытия: вопрос агента человек увидел бы только после F5. То же
  // с припаркованным прогоном — потока к нему нет, правда в транскрипте.
  useChatAutoRefresh(activeChat?.id, isRunning, run.stalled === true || run.parked === true);
  // Прогресс агента читается из транскрипта, поэтому нужен настоящий id сессии:
  // у нового разговора он появляется только с первым событием потока.
  const progress = useChatProgress(activeChat?.id ?? run.sessionId, isRunning);

  const { artifacts, artifactToDelete, askDelete, cancelDelete, confirmDelete, isDeleting } =
    useChatArtifacts({ chatId, preview, setPreview: session.setPreview });

  useRunLifecycle({
    chatId,
    activeChatId: activeChat?.id,
    isRunning,
    runText: run.text,
    runStatus: run.status,
    refresh: session.refresh,
    messagesUpdatedAt: messages.dataUpdatedAt,
    messagesData: messages.data,
  });

  useAgentNotifications({
    chatId,
    children: child.list,
    // Ребёнок открывается ЗДЕСЬ же — тем же путём, что и клик по нему в пульте
    // агентов: его каталог лежит в самом разговоре, вкладка не нужна.
    onOpenChild: session.openChatById,
    runId: run.id,
    runStatus: run.status,
  });

  // Снятие оптимистичных пузырей — правило целиком в `keepPending`, вместе с
  // объяснением, почему одной сверки по тексту не хватает.
  useEffect(() => {
    if (pending.length === 0 || !messages.data) return;
    session.setPending((current) => keepPending(current, messageList));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.data]);

  const { editMessage, dispatch, send, answerQuestion } = useChatSend({
    chatId,
    activeChatId: activeChat?.id,
    sessionId: run.sessionId,
    projectPath,
    isRunning,
    input,
    setInput,
    setDraftId: session.setDraftId,
    setPending: session.setPending,
    allowEdits,
    autoApprove,
    ...models.effective,
  });

  const { isParallelOpen, setParallelOpen, launchParallel } = useParallelLaunch({
    ...models.effective,
    // Тот же ключ, что и у разделения: запущенные встают ветвями этого
    // разговора, а не отдельными вкладками проектов.
    parentChatId: activeChat?.id ?? run.sessionId,
  });

  // Разделение списка задач по нескольким чатам: агент предлагает его блоком в
  // ответе, панель показывает карточку, а копии заводит сервер одним запросом.
  const taskSplit = useTaskSplit({
    projectPath,
    // Настоящий ключ разговора, а не черновик: под ним чат стоит в списке, и
    // именно к нему дерево подвесит порождённые чаты.
    parentChatId: activeChat?.id ?? run.sessionId,
    allowEdits,
    ...models.effective,
    dispatch,
  });

  // Продолжение в чистой сессии: этап закрыт — работа уезжает в новый разговор
  // того же проекта, а дорогой контекст остаётся позади. Заводит его сервер, в
  // том числе сам, когда в разговоре включён автомат.
  const handoff = useChatHandoff({
    projectPath,
    chatId,
    sessionId: run.sessionId,
    allowEdits,
    ...models.effective,
    dispatch,
    showChat: session.viewRun,
  });

  // Автоподтверждение прав: запоминаем выбор для всех чатов и, если прогон уже
  // идёт, сообщаем о нём серверу — иначе тумблер подействовал бы только со
  // следующего сообщения.
  const toggleAutoApprove = (enabled: boolean): void => {
    setAutoApprove(enabled);
    if (chatId) agentRuns.setAutoApprove(chatId, enabled);
  };

  return (
    <div className={styles.shell}>
      {/* Гейт ключа ассистента: модалка, если у активного провайдера раннер
          `none` (нет ключа и CLI). Для Claude с CLI модалки нет (регресс-ноль). */}
      <AssistantKeyGate />

      {ws.state.projectTabs.length > 0 && (
        <WorkspaceTabs
          projectTabs={ws.state.projectTabs}
          activeTabId={ws.state.activeTabId}
          statuses={projectStatuses}
          onActivate={ws.activate}
          onClose={session.closeProjectTab}
          onReorder={ws.reorderProjects}
          onMove={ws.moveProject}
        />
      )}

      <div
        className={`${styles.page} ${preview ? styles.pageWithPreview : ''}`}
        style={
          preview
            ? { gridTemplateColumns: `300px minmax(0, 1fr) auto ${previewWidth}px` }
            : undefined
        }
      >
        <ChatSidebar
          isHome={ws.isHome}
          chats={shownChats}
          isChatsLoading={chats.isLoading}
          activeChatId={activeChat?.id}
          chatStatuses={chatStatuses}
          onSelectChat={session.openChat}
          onCreateChat={ws.activeProject ? () => session.enterProjectDraft() : session.startNewChat}
          projects={projects.data ?? []}
          isProjectsLoading={projects.isLoading}
          activeProjectId={ws.activeProject?.id}
          projectStatuses={projectStatuses}
          onOpenProject={session.openProject}
          onAddFolder={() => setFolderPickerOpen(true)}
          onParallelLaunch={() => setParallelOpen(true)}
        />

        <div className={styles.main}>
          <ChatHeader
            chatTitle={activeChat?.title}
            projectName={ws.activeProject?.name}
            projectPath={projectPath}
            isProjectContext={isProjectContext}
            chatId={chatId}
            activeRuns={activeRuns}
            totalCost={spend.cost}
            totalTokens={spend.tokens}
            costUnit={costUnit}
            onStopRun={agentRuns.stop}
            onStopAllRuns={agentRuns.stopAll}
            onViewRun={session.viewRun}
            model={models.modelOverride}
            effort={models.effortOverride}
            defaultModel={models.defaultModel}
            defaultEffort={models.defaultEffort}
            models={modelCatalog?.models}
            onModelChange={models.setModelOverride}
            onEffortChange={models.setEffortOverride}
            isEditorPending={openEditor.isPending}
            onOpenEditor={(path) => openEditor.mutate(path)}
            onOpenCode={() => setCodeOpen(true)}
            onOpenTests={() => setTestsOpen(true)}
            allowEdits={allowEdits}
            onAllowEditsChange={setAllowEdits}
            autoApprove={autoApprove}
            onAutoApproveChange={toggleAutoApprove}
            runStatus={run.status}
            onRetry={() => chatId && agentRuns.retry(chatId)}
            onContinue={() => dispatch(t('chat.continueWord'), [])}
            onAllowAndContinue={() => chatId && agentRuns.retry(chatId, { fullAccess: true })}
            tokens={run.tokens}
            costUsd={run.costUsd}
            limitResetsAt={run.limitResetsAt}
            canExport={Boolean(activeChat)}
            onExport={() => activeChat && downloadChatExport(activeChat.id, 'md')}
            onRefresh={() => session.refresh()}
          />

          <ChatArtifactsBar
            artifacts={artifacts}
            onPreview={(artifact) => session.setPreview(artifact)}
            onDelete={askDelete}
          />

          <ChatThread
            messages={[...shownHistory, ...pending]}
            conversationId={activeChat?.id}
            stream={stream}
            isLoading={messages.isLoading}
            hasMore={messages.data?.hasMore}
            isLoadingMore={messages.isFetching}
            onLoadMore={() => setMessagesLimit((limit) => limit + CHAT_PAGE_SIZE)}
            onEdit={editMessage}
            onPickOption={answerQuestion}
            isRunning={isRunning}
            chatId={chatId}
            permissions={run.permissions}
            queued={run.queued}
            onCancelQueued={(queuedId) => chatId && agentRuns.cancelQueued(chatId, queuedId)}
            child={child}
            chats={chats.data ?? []}
            activeRuns={activeRuns}
            childAnswerOptions={{ allowEdits, autoApprove, ...models.effective }}
            costUnit={costUnit}
            effort={run.effort}
            taskSplit={taskSplit}
            onContinue={() => chatId && agentRuns.continue(chatId, t('chat.continueWord'))}
            onRefresh={() => {
              session.refresh();
              if (chatId) agentRuns.quiet(chatId);
            }}
            handoff={handoff.controls}
            isProjectContext={isProjectContext}
            projectName={ws.activeProject?.name}
            projectPath={projectPath}
            onOpenEditor={(path) => openEditor.mutate(path)}
            onPickPrompt={setInput}
          />

          <ChatDock
            progress={progress.data}
            isRunning={isRunning}
            queued={run.queued}
            onCancelQueued={(queuedId) => chatId && agentRuns.cancelQueued(chatId, queuedId)}
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={() => chatId && agentRuns.stop(chatId)}
            onSplitTasks={taskSplit.askSplit}
            onHandoff={handoff.askHandoff}
          />
        </div>

        {preview && chatId && (
          <ChatPreviewPane
            chatId={chatId}
            artifact={preview}
            width={previewWidth}
            onResize={resizePreview}
            onClose={() => session.setPreview(undefined)}
          />
        )}
      </div>

      <ChatOverlays
        isFolderPickerOpen={isFolderPickerOpen}
        onFolderPickerOpenChange={setFolderPickerOpen}
        onPickFolder={(path, name) => {
          session.openProjectPath(path, name);
          setFolderPickerOpen(false);
        }}
        artifactToDelete={artifactToDelete}
        onCancelDelete={cancelDelete}
        onConfirmDelete={confirmDelete}
        isDeleting={isDeleting}
        isProjectContext={isProjectContext}
        projectPath={projectPath}
        activeChatId={activeChat?.id}
        isCodeOpen={isCodeOpen}
        onCodeOpenChange={setCodeOpen}
        isTestsOpen={isTestsOpen}
        onTestsOpenChange={setTestsOpen}
        isParallelOpen={isParallelOpen}
        onParallelOpenChange={setParallelOpen}
        projects={projects.data ?? []}
        onLaunch={launchParallel}
      />
    </div>
  );
}
