import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatConsumerOf } from '@agentdeck/contracts/platform-consumers';
import { useWorkspace } from '@shared/lib/workspace';
import {
  agentRuns,
  pendingBubbles,
  useAgentRun,
  useActiveRuns,
  useTotalCost,
  useTotalTokens,
} from '@shared/lib/agent-runs';
import { useChatPrefs } from '@shared/lib/chat-prefs';
import { useDraftBox } from '@shared/lib/draft';
import { WorkspaceTabs } from '@features/WorkspaceTabs';
import { limitHolds } from '@features/ChatLimitCard';
import { AssistantKeyGate } from '@features/AssistantKeyGate';
import { ProjectGitControls } from '@features/ProjectGit';
import { useRunModelName } from '@features/ChatModelPicker';
import { useChats } from '@entities/Chat';
import { closeAgentPane } from '@entities/AgentTree';
import { useProjects, useOpenInEditor } from '@entities/Project';
import { useSettings } from '@entities/AppConfig';
import { TurnToolHintLine, usePlatformRunPlan } from '@entities/Platform';
import { Stack } from '@shared/ui/stack';
import { useChatMedia } from '@entities/Media';
import { ChatSidebar } from '../ChatSidebar/ChatSidebar';
import { ChatHeader } from '../ChatHeader/ChatHeader';
import { ChatArtifactsBar } from '../ChatArtifactsBar/ChatArtifactsBar';
import { ChatThread } from '../ChatThread/ChatThread';
import { ChatOverlays } from '../ChatOverlays/ChatOverlays';
import { ForkConfirm } from '../ForkConfirm/ForkConfirm';
import type { ProjectWindow } from '../ChatOverlays/ChatOverlays.types';
import { ChatDock } from '../ChatDock/ChatDock';
import { ChatPreviewPane } from '../ChatPreviewPane/ChatPreviewPane';
import { useChatSession } from '../model/useChatSession';
import { useChatSend } from '../model/useChatSend';
import { useChatArtifacts } from '../model/useChatArtifacts';
import { useParallelLaunch } from '../model/useParallelLaunch';
import { useChatHandoff } from '../model/useChatHandoff';
import { useRunLifecycle } from '../model/useRunLifecycle';
import { useQueuedAsPending } from '../model/useQueuedAsPending';
import { useAgentNotifications } from '../model/useAgentNotifications';
import { useAskFromWindow } from '../model/useAskFromWindow';
import { usePreviewWidth } from '../model/usePreviewWidth';
import { visibleChats } from '../lib/visibleChats';
import { useChildHub } from '../model/useChildHub';
import { useChatDots } from '../model/useChatDots';
import { useProjectShelf } from '../model/useProjectShelf';
import { useChatModelPrefs } from '../model/useChatModelPrefs';
import { useChatCliModels } from '../model/useChatCliModels';
import { useChatFeed } from '../model/useChatFeed';
import { useChatAutoApprove } from '../model/useChatAutoApprove';
import { coreTaskOf, useCoreAutoGrant } from '../model/useCoreAutoGrant';
import { useLocalRun } from '../model/useLocalRun';
import { useStreamState } from '../model/useStreamState';
import { useRefusalStream } from './useRefusalStream';
import { CoreRefusalLine } from './CoreRefusalLine';
import { useProjectParam } from './useProjectParam';
import { useSitePick } from './useSitePick';
import { ChatSiteStrip } from './ChatSiteStrip';
import { dockSend } from './dockSend';
import { downloadChatExport } from '../lib/downloadChatExport';
import { keepPending } from '../lib/pending';
import { runAssignment } from '../lib/runAssignment';
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
  // Тумблер прав — в chatPrefs (localStorage): правки разрешены по умолчанию и не слетают.
  const { allowEdits, setAllowEdits } = useChatPrefs();
  const [isFolderPickerOpen, setFolderPickerOpen] = useState(false);
  const [projectWindow, setProjectWindow] = useState<ProjectWindow>();
  const openEditor = useOpenInEditor();
  const { data: settings } = useSettings();
  const costUnit = settings?.costUnit ?? 'tokens';

  const chats = useChats();
  const projects = useProjects();
  const shelf = useProjectShelf();
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
  // `?project=` — вкладка этого проекта (W3-17a: туда ведёт и старый адрес `/core/chat`), `?id=`
  // остаётся открытым в ней. Пока список грузится — `undefined`; ошибка списка — `[]`.
  useProjectParam(projects.isPending ? undefined : (projects.data ?? []), session.openAddressTab);
  const run = useAgentRun(chatId);
  // Авторежим прав этого чата: выбор чата сильнее глобальной настройки (подробности — в хуке).
  const autoMode = useChatAutoApprove(chatId, run.sessionId, settings?.chatAutoMode);
  // Ход через ядро: тумблер включён — грант правки задаче шлёт это окно (сервер не вправе).
  useCoreAutoGrant(chatId, run, autoMode.autoApprove);
  // Задача ядра хода — карточке лимита: варианты перевода и точный сброс из её вида (этап 12, L3).
  const coreTaskId = coreTaskOf(chatId, run)?.taskId;
  // Досланное из очереди сразу встаёт в ленту своим пузырём (см. хук).
  useQueuedAsPending(run.sentFromQueue, session.setPending);
  const isRunning = run.status === 'running';
  const runStream = useStreamState(run, isRunning);
  // Отказ ядра запуску CLI (W3-17a) — строкой на месте композера, лента его не повторяет.
  const { refusal, stream } = useRefusalStream(runStream);

  const draft = useDraftBox(draftKey);
  const fromWindow = useAskFromWindow(draft, () => setProjectWindow(undefined));

  // Модель и глубина продумывания: общий дефолт из настроек, глубина, назначенная
  // разговору панелью, и выбор этого разговора (подробности — в хуке). Прогон
  // без строки в списке назначен сервером — его модель тоже назначенная.
  // Модели CLI ЭТОГО разговора (W3-17a): новый — активного провайдера, начатый — своего CLI.
  const chatCli = useChatCliModels(activeChat?.id ?? run.sessionId, !isRunning);
  // Потребитель контура — по CLI разговора, тем же правилом, что ведёт ход на сервере
  // (`chatConsumerOf`): разговор qwen идёт через контур по `foreign:qwen`, а не по «Чату».
  const consumer = activeChat?.parentId ? 'groups' : chatConsumerOf(chatCli.cli ?? 'claude');
  const localRun = useLocalRun(consumer, projectPath);
  // Через контур модель решает его перевод, а не CLI: тот же план, что запирает шапку.
  const runPlan = usePlatformRunPlan(consumer, projectPath ?? '');
  const models = useChatModelPrefs(draftKey, settings, runAssignment(activeChat, run), {
    ...(chatCli.cli ? { cli: chatCli.cli } : {}),
    ...(chatCli.models ? { catalog: chatCli.models } : {}),
    contour: runPlan.data?.routed === true,
  });
  // Кто ответит: подпись ожидания называет модель, а через контур — модель контура.
  const modelName = useRunModelName({
    consumer,
    model: models.modelOverride,
    defaultModel: models.defaultModel,
    ...(chatCli.cli ? { cli: chatCli.cli } : {}),
  });

  const shownChats = useMemo(
    () => visibleChats(chats.data ?? [], ws.activeProject?.id),
    [chats.data, ws.activeProject],
  );

  // Родительский чат как пульт над детьми разделения: их вопросы, их запросы
  // прав и они сами — по именам (подробности и почему именно так — в хуке).
  // Четвёртым — чей ребёнок сам этот разговор: карточку решения по ревью (Т7)
  // человек видит и в группе, а её состояние лежит в дереве родителя.
  const child = useChildHub(chats.data, activeChat?.id, activeRuns);

  // Лента: окно истории, история без текущего хода, подсказка контура,
  // автообновление, прогресс агента и ход субагента справа (подробности — в хуке).
  const feed = useChatFeed({ activeChatId: activeChat?.id, consumer, run, stream, isRunning });

  const { artifacts, artifactToDelete, askDelete, cancelDelete, confirmDelete, isDeleting } =
    useChatArtifacts({ chatId, preview, setPreview: session.setPreview });

  useRunLifecycle({
    chatId,
    activeChatId: activeChat?.id,
    isRunning,
    runText: run.text,
    runStatus: run.status,
    refresh: session.refresh,
    messagesUpdatedAt: feed.messages.dataUpdatedAt,
    messagesData: feed.messages.data,
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
    if (pending.length === 0 || !feed.messages.data) return;
    session.setPending((current) => keepPending(current, feed.messageList));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.messages.data]);

  const { editMessage, dispatch, send, answerQuestion, forkConfirm } = useChatSend({
    chatId,
    activeChatId: activeChat?.id,
    sessionId: run.sessionId,
    projectPath,
    isRunning,
    draft,
    setDraftId: session.setDraftId,
    setPending: session.setPending,
    allowEdits,
    autoApprove: autoMode.override,
    ...models.effective,
  });

  const { isParallelOpen, setParallelOpen, launchParallel } = useParallelLaunch({
    ...models.effective,
    // Тот же ключ, что и у разделения: запущенные встают ветвями этого
    // разговора, а не отдельными вкладками проектов.
    parentChatId: activeChat?.id ?? run.sessionId,
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

  // Режимы «Картинка» и «Презентация». Две дороги, и человек видит, какая
  // работает: панель делает сама (контур, ручка картинок, свой эндпоинт) — тогда
  // результат живёт своей карточкой и в переписку Claude Code не попадает; либо
  // просит АГЕНТА этого разговора, и тогда это обычное сообщение, а ответ
  // приезжает блоком в ленту. Второй дорогой режимы работают и без контура.
  const media = useChatMedia({
    chatId: activeChat?.id ?? '',
    ask: (text) => dispatch(text, []),
    closePreview: () => session.setPreview(undefined),
  });
  // Окно сайта проекта (этап 12, D20): полоса над лентой, окно справа, выбор — чипом в поле.
  const site = useSitePick({ session, draft, media, agentPane: feed.agentPane });
  // Столбец один: открытый результат сильнее предпросмотра артефакта — его
  // только что попросили, а предпросмотр открывали раньше.
  const isRightOpen = Boolean(
    site.pane || preview || media.shownImage || media.shownDeck || feed.agentPane,
  );

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
        className={`${styles.page} ${isRightOpen ? styles.pageWithPreview : ''}`}
        // Ширина превью — переменной, а не готовой сеткой: сетку держит CSS, и
        // только он знает ширину экрана, чтобы разговору осталось место.
        style={
          isRightOpen
            ? ({ '--preview-width': `${previewWidth}px` } as React.CSSProperties)
            : undefined
        }
      >
        <ChatSidebar
          className={styles.sidebarCell}
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
          shelf={shelf}
        />

        <div className={styles.main}>
          <ChatHeader
            chatTitle={activeChat?.title}
            projectName={ws.activeProject?.name}
            projectPath={projectPath}
            isProjectContext={isProjectContext}
            chatId={chatId}
            {...(run.sessionId ? { sessionId: run.sessionId } : {})}
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
            models={chatCli.models}
            {...(chatCli.cli ? { cli: chatCli.cli } : {})}
            // Кем прогон пойдёт через контур. Связь с родителем заводит только
            // разделение, и сервер по ней же спрашивает маршрут потребителем
            // «Группы» — шапка обязана спрашивать тем же, иначе она говорит про
            // чужой маршрут (ревью Т8).
            consumer={consumer}
            onModelChange={models.setModelOverride}
            onEffortChange={models.setEffortOverride}
            isEditorPending={openEditor.isPending}
            onOpenEditor={(path) => openEditor.mutate(path)}
            onOpenCode={() => setProjectWindow('code')}
            onOpenTests={() => setProjectWindow('tests')}
            onOpenEnvironment={() => setProjectWindow('environment')}
            allowEdits={allowEdits}
            onAllowEditsChange={setAllowEdits}
            autoApprove={autoMode.autoApprove}
            onAutoApproveChange={autoMode.toggle}
            runStatus={run.status}
            errorOverflow={run.errorOverflow}
            limitHolds={limitHolds(stream)}
            onRetry={() => chatId && agentRuns.retry(chatId)}
            onContinue={() => dispatch(t('chat.continueWord'), [])}
            onAllowAndContinue={() => chatId && agentRuns.retry(chatId, { fullAccess: true })}
            tokens={run.tokens}
            costUsd={run.costUsd}
            limitResetsAt={run.limitResetsAt}
            canExport={Boolean(activeChat)}
            onExport={() => activeChat && downloadChatExport(activeChat.id, 'md')}
            onRefresh={() => session.refresh()}
            {...(handoff.restartSession ? { onRestartSession: handoff.restartSession } : {})}
          />

          {/* Ветка и числа правок — полосой над лентой, а не кнопкой в ряду
              шапки: пока агент работает, это первое, на что смотрят, а в ряду
              оно терялось между моделью и кнопками. Нет `.git` в каталоге —
              сам компонент вернёт null, полосы не будет вовсе. */}
          {isProjectContext && projectPath && (
            <ProjectGitControls path={projectPath} variant="strip" isRunning={isRunning} />
          )}
          <ChatSiteStrip site={site} />

          <ChatArtifactsBar
            artifacts={artifacts}
            // Столбец один: открытый артефакт убирает картинку, как картинка
            // убирает артефакт. Иначе выбранный файл не показывался бы вовсе.
            onPreview={(artifact) => {
              media.close();
              closeAgentPane(false);
              site.close();
              session.setPreview(artifact);
            }}
            onDelete={askDelete}
          />

          <ChatThread
            messages={[...feed.shownHistory, ...pending]}
            conversationId={activeChat?.id}
            liveConversationId={activeChat?.id ?? run.sessionId}
            stream={stream}
            modelName={modelName}
            isLoading={feed.messages.isLoading}
            hasMore={feed.messages.data?.hasMore}
            isLoadingMore={feed.messages.isFetching}
            onLoadMore={feed.messagesLimit.loadMore}
            onEdit={editMessage}
            onPickOption={answerQuestion}
            isRunning={isRunning}
            runStartedAt={run.startedAt}
            localRun={localRun}
            chatId={chatId}
            {...(coreTaskId ? { coreTaskId } : {})}
            permissions={run.permissions}
            queued={pendingBubbles(run)}
            onCancelQueued={(queuedId) => chatId && agentRuns.cancelQueued(chatId, queuedId)}
            child={child}
            // Звено открывается ЗДЕСЬ же, как и переход к ребёнку из тоста:
            // каталог у разговора свой, вкладка копии для него не нужна.
            onOpenChild={session.openChatById}
            chats={chats.data ?? []}
            activeRuns={activeRuns}
            childAnswerOptions={{ allowEdits, ...models.effective }}
            costUnit={costUnit}
            effort={run.effort}
            onContinue={() => chatId && agentRuns.continue(chatId, t('chat.continueWord'))}
            onCompact={() => dispatch('/compact', [])}
            {...(handoff.restartOverflow ? { onFreshSession: handoff.restartOverflow } : {})}
            onRefresh={() => {
              session.refresh();
              if (chatId) agentRuns.quiet(chatId);
            }}
            handoff={handoff.controls}
            isProjectContext={isProjectContext}
            projectName={ws.activeProject?.name}
            projectPath={projectPath}
            onOpenEditor={(path) => openEditor.mutate(path)}
            onPickPrompt={draft.set}
            // Тема и правка колоды: карточка в ленте подписывается темой
            // человека и она же начинает правку — у блока агента другого места
            // для этого нет.
            {...(media.topic ? { mediaTopic: media.topic } : {})}
            mediaRevision={media.revision}
          />

          {feed.toolHint && (
            <Stack padding="0 var(--spacing-xl)">
              <TurnToolHintLine hint={feed.toolHint} />
            </Stack>
          )}

          {refusal ? (
            <CoreRefusalLine refusal={refusal} />
          ) : (
            <ChatDock
              {...(session.draftId ? { focusKey: session.draftId } : {})}
              progress={feed.progress.data}
              {...(feed.progressChatId ? { progressChatId: feed.progressChatId } : {})}
              isRunning={isRunning}
              awaiting={run.status === 'waiting' || Boolean(activeChat?.awaitingReply)}
              queued={run.queued}
              onCancelQueued={(queuedId) => chatId && agentRuns.cancelQueued(chatId, queuedId)}
              draft={draft}
              // Режим картинки делает сам, текст уходит агенту с блоками чипов сайта.
              onSend={dockSend(media, draft, send, site)}
              onStop={() => chatId && agentRuns.stop(chatId)}
              onHandoff={handoff.askHandoff}
              modes={media.modes}
            />
          )}
        </div>

        {isRightOpen && (
          <ChatPreviewPane
            // Картинке разговор не нужен — её адрес свой; артефакт без разговора
            // не появляется, и пустая строка до него не доходит.
            chatId={chatId ?? ''}
            site={site.pane}
            {...(media.shownImage ? { image: media.shownImage } : {})}
            {...(media.shownDeck ? { deck: media.shownDeck } : {})}
            {...(preview ? { artifact: preview } : {})}
            {...(feed.agentPane ? { agent: feed.agentPane } : {})}
            onCloseAgent={() => closeAgentPane()}
            width={previewWidth}
            onResize={resizePreview}
            onClose={
              (media.shownImage ?? media.shownDeck)
                ? media.close
                : () => session.setPreview(undefined)
            }
            onReviseDeck={media.revision.onStart}
          />
        )}
      </div>

      <ForkConfirm isOpen={forkConfirm.isOpen} onAnswer={forkConfirm.answer} />
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
        diffNotesSend={{
          chatId,
          isRunning,
          dispatch: (prompt) => dispatch(prompt, []),
          message: { allowEdits, autoApprove: autoMode.override, ...models.effective },
        }}
        projectWindow={projectWindow}
        onProjectWindowChange={setProjectWindow}
        onAskAgent={fromWindow.askAgent}
        environmentFocusOnClose={fromWindow.focusOnClose}
        isParallelOpen={isParallelOpen}
        onParallelOpenChange={setParallelOpen}
        projects={projects.data ?? []}
        parallelCeiling={models.effective}
        onLaunch={launchParallel}
      />
    </div>
  );
}
