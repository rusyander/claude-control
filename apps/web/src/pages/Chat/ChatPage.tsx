import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspace, normalizeProjectPath } from '@shared/lib/workspace';
import {
  agentRuns,
  useAgentRun,
  useProjectStatuses,
  useChatStatuses,
  useActiveRuns,
  useTotalCost,
  useTotalTokens,
} from '@shared/lib/agent-runs';
import { useChatPrefs } from '@shared/lib/chat-prefs';
import { useDraft } from '@shared/lib/draft';
import { WorkspaceTabs } from '@features/WorkspaceTabs';
import { ParallelLaunch } from '@features/ParallelLaunch';
import { FolderPicker } from '@features/FolderPicker';
import { ProjectCodeModal } from '@features/ProjectCode';
import { ProjectTestsModal } from '@features/ProjectTests';
import { AssistantKeyGate } from '@features/AssistantKeyGate';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { ChatMessages } from '@features/ChatMessages';
import {
  useChats,
  useChatMessages,
  useChatAutoRefresh,
  useChatProgress,
  CHAT_PAGE_SIZE,
  useAwaitingChats,
  mergeAwaitingStatuses,
  mergeAwaitingProjectStatuses,
} from '@entities/Chat';
import { useProjects, useOpenInEditor } from '@entities/Project';
import { useSettings } from '@entities/AppConfig';
import { useModelCatalog } from '@entities/ModelCatalog';
import { ChatSidebar } from './ChatSidebar';
import { ChatHeader } from './ChatHeader';
import { ChatArtifactsBar } from './ChatArtifactsBar';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatDock } from './ChatDock';
import { ChatPreviewPane } from './ChatPreviewPane';
import { useChatSession } from './model/useChatSession';
import { useChatSend } from './model/useChatSend';
import { useChatArtifacts } from './model/useChatArtifacts';
import { useParallelLaunch } from './model/useParallelLaunch';
import { useRunLifecycle } from './model/useRunLifecycle';
import { useAgentNotifications } from './model/useAgentNotifications';
import { usePreviewWidth } from './model/usePreviewWidth';
import { useStreamState } from './model/useStreamState';
import { downloadChatExport } from './lib/downloadChatExport';
import { plainTextOf } from './lib/plainTextOf';
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
  const liveProjectStatuses = useProjectStatuses();
  // Точки в списке чатов: в одном проекте агентов может быть несколько, и по
  // точке на табе не понять, который из разговоров зовёт.
  const liveChatStatuses = useChatStatuses();
  // Разговор мог стоять на вопросе задолго до того, как открыли панель, — или
  // идти вовсе мимо неё. Такие видны только по транскрипту, и точку им ставит
  // тот же механизм, что и живым прогонам.
  const awaitingChats = useAwaitingChats();
  const chatStatuses = useMemo(
    () => mergeAwaitingStatuses(liveChatStatuses, awaitingChats),
    [liveChatStatuses, awaitingChats],
  );
  const projectStatuses = useMemo(
    () => mergeAwaitingProjectStatuses(liveProjectStatuses, awaitingChats),
    [liveProjectStatuses, awaitingChats],
  );
  const activeRuns = useActiveRuns();
  const totalCost = useTotalCost();
  const totalTokens = useTotalTokens();

  // Какой разговор открыт, в каком каталоге он идёт и как между разговорами
  // ходят: всё это живёт в одном месте — здесь только читаем.
  const session = useChatSession({ chats: chats.data });
  const { activeChat, chatId, projectPath, isProjectContext, draftKey, preview, pending } = session;

  const run = useAgentRun(chatId);
  const isRunning = run.status === 'running';
  const stream = useStreamState(run, isRunning);

  const [input, setInput] = useDraft(draftKey);

  // Модель и глубина продумывания. Глобальный дефолт — из настроек; в конкретном
  // чате его можно переопределить локально (пер-чат оверрайд в localStorage,
  // пусто = брать из настроек). Настройки этим не меняются.
  const defaultModel = settings?.chatModel ?? '';
  const defaultEffort = settings?.chatEffort ?? 'xhigh';
  const [modelOverride, setModelOverride] = useDraft(`chat-model:${draftKey}`);
  const [effortOverride, setEffortOverride] = useDraft(`chat-effort:${draftKey}`);
  const effectiveModel = modelOverride || defaultModel;
  const effectiveEffort = effortOverride || defaultEffort;

  const visibleChats = useMemo(() => {
    const all = chats.data ?? [];
    if (ws.activeProject) {
      const id = ws.activeProject.id;
      return all.filter((chat) => !chat.isSandbox && normalizeProjectPath(chat.projectPath) === id);
    }
    return all.filter((chat) => chat.isSandbox);
  }, [chats.data, ws.activeProject]);

  // Размер окна ленты. Растёт кнопкой «Загрузить ещё»: каждый шаг подтягивает
  // более ранние сообщения. При смене разговора возвращаемся к последнему окну.
  const [messagesLimit, setMessagesLimit] = useState(CHAT_PAGE_SIZE);
  useEffect(() => {
    setMessagesLimit(CHAT_PAGE_SIZE);
  }, [activeChat?.id]);

  const messages = useChatMessages(activeChat?.id, messagesLimit);
  const messageList = messages.data?.messages ?? [];
  // Разговор мог продолжиться мимо панели — из терминала или расширения
  // редактора. Такой ход не даёт потока событий, и лента жила бы снимком на
  // момент открытия: вопрос агента человек увидел бы только после F5.
  useChatAutoRefresh(activeChat?.id, isRunning);
  // Прогресс агента читается из транскрипта, поэтому нужен настоящий id сессии:
  // у нового разговора он появляется только с первым событием потока.
  const progress = useChatProgress(activeChat?.id ?? run.sessionId, isRunning);

  const { artifacts, artifactToDelete, askDelete, cancelDelete, confirmDelete, isDeleting } =
    useChatArtifacts({ chatId, preview, setPreview: session.setPreview });

  useRunLifecycle({
    chatId,
    isRunning,
    runText: run.text,
    runStatus: run.status,
    refresh: session.refresh,
    messagesUpdatedAt: messages.dataUpdatedAt,
    messagesData: messages.data,
  });

  useAgentNotifications({ chatId, runId: run.id, runStatus: run.status });

  useEffect(() => {
    if (pending.length === 0 || !messages.data) return;
    const inHistory = new Set(
      messageList.filter((message) => message.role === 'user').map(plainTextOf),
    );
    session.setPending((current) =>
      current.filter((message) => !inHistory.has(plainTextOf(message))),
    );
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
    model: effectiveModel,
    effort: effectiveEffort,
  });

  const { isParallelOpen, setParallelOpen, launchParallel } = useParallelLaunch({
    model: effectiveModel,
    effort: effectiveEffort,
  });

  // Автоподтверждение прав: запоминаем выбор для всех чатов и, если прогон уже
  // идёт, сообщаем о нём серверу — иначе тумблер подействовал бы только со
  // следующего сообщения.
  const toggleAutoApprove = (enabled: boolean): void => {
    setAutoApprove(enabled);
    if (chatId) agentRuns.setAutoApprove(chatId, enabled);
  };

  const hasContent =
    messageList.length > 0 ||
    pending.length > 0 ||
    messages.isLoading ||
    isRunning ||
    Boolean(run.text) ||
    Boolean(run.error);

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
          chats={visibleChats}
          isChatsLoading={chats.isLoading}
          activeChatId={activeChat?.id}
          chatStatuses={chatStatuses}
          onSelectChat={session.openChat}
          onCreateChat={
            ws.activeProject
              ? () => ws.activeProject && session.enterProjectDraft()
              : session.startNewChat
          }
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
            totalCost={totalCost}
            totalTokens={totalTokens}
            costUnit={costUnit}
            onStopRun={agentRuns.stop}
            onStopAllRuns={agentRuns.stopAll}
            onViewRun={session.viewRun}
            model={modelOverride}
            effort={effortOverride}
            defaultModel={defaultModel}
            defaultEffort={defaultEffort}
            models={modelCatalog?.models}
            onModelChange={setModelOverride}
            onEffortChange={setEffortOverride}
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

          {hasContent ? (
            <ChatMessages
              messages={[...messageList, ...pending]}
              conversationId={activeChat?.id}
              stream={stream}
              isLoading={messages.isLoading}
              hasMore={messages.data?.hasMore}
              isLoadingMore={messages.isFetching}
              onLoadMore={() => setMessagesLimit((limit) => limit + CHAT_PAGE_SIZE)}
              onEdit={editMessage}
              onPickOption={answerQuestion}
              isRunning={isRunning}
              permissions={run.permissions}
              onPermissionDecide={(toolUseId, behavior) =>
                chatId && agentRuns.decidePermission(chatId, toolUseId, behavior)
              }
              onRetry={chatId ? () => agentRuns.retry(chatId) : undefined}
              costUnit={costUnit}
              effort={run.effort}
            />
          ) : (
            <ChatEmptyState
              isProjectContext={isProjectContext}
              projectName={ws.activeProject?.name}
              projectPath={projectPath}
              onOpenEditor={(path) => openEditor.mutate(path)}
              onPick={setInput}
            />
          )}

          <ChatDock
            progress={progress.data}
            isRunning={isRunning}
            queued={run.queued}
            onCancelQueued={(queuedId) => chatId && agentRuns.cancelQueued(chatId, queuedId)}
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={() => chatId && agentRuns.stop(chatId)}
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

      <FolderPicker
        isOpen={isFolderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onPick={(path, name) => {
          session.openProjectPath(path, name);
          setFolderPickerOpen(false);
        }}
      />

      <ConfirmDialog
        isOpen={Boolean(artifactToDelete)}
        onOpenChange={(open) => !open && cancelDelete()}
        onConfirm={confirmDelete}
        title={t('chat.deleteArtifactTitle')}
        description={t('chat.deleteArtifactConfirm', { name: artifactToDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        isPending={isDeleting}
      />

      {/* Код проекта. Разговор передаём, чтобы дифф показывал правки ИМЕННО
          этого чата; в песочнице кнопки нет — окно живёт только у проекта. */}
      {isProjectContext && projectPath && (
        <ProjectCodeModal
          isOpen={isCodeOpen}
          onOpenChange={setCodeOpen}
          projectPath={projectPath}
          chatId={activeChat?.id}
        />
      )}

      {/* Тест-кейсы живут в самом проекте, поэтому окно знает только его путь:
          к конкретному разговору они не привязаны. */}
      {isProjectContext && projectPath && (
        <ProjectTestsModal
          isOpen={isTestsOpen}
          onOpenChange={setTestsOpen}
          projectPath={projectPath}
        />
      )}

      <ParallelLaunch
        isOpen={isParallelOpen}
        onOpenChange={setParallelOpen}
        projects={projects.data ?? []}
        onLaunch={launchParallel}
      />
    </div>
  );
}
