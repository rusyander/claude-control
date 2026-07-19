import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Artifact, ChatMessage, ChatSummary } from '@claude-control/contracts';
import { HELP_ROUTE } from '@shared/config/routes';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useWorkspace, normalizeProjectPath, HOME_TAB_ID } from '@shared/lib/workspace';
import {
  agentRuns,
  useAgentRun,
  useProjectStatuses,
  useActiveRuns,
  useTotalCost,
  useTotalTokens,
  type ActiveRunView,
} from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { useChatPrefs, getChatPrefs } from '@shared/lib/chat-prefs';
import { playNotification } from '@shared/lib/notify-sound';
import { useDraft } from '@shared/lib/draft';
import { formatSpend } from '@shared/lib/format';
import { ChatList } from '@features/ChatList';
import { ProjectList } from '@features/ProjectList';
import { WorkspaceTabs } from '@features/WorkspaceTabs';
import { AgentsPanel } from '@features/AgentsPanel';
import { ChatModelPicker } from '@features/ChatModelPicker';
import { ParallelLaunch } from '@features/ParallelLaunch';
import { FolderPicker } from '@features/FolderPicker';
import { ChatMessages } from '@features/ChatMessages';
import { ChatComposer } from '@features/ChatComposer';
import { ArtifactPreview } from '@features/ArtifactPreview';
import {
  useChats,
  useChatMessages,
  useArtifacts,
  useRefreshChat,
  chatKeys,
} from '@entities/Chat/api/ChatApi';
import type { StreamState } from '@entities/Chat/model/useChatStream';
import { useProjects, useOpenInEditor, type ProjectInfo } from '@entities/Project';
import { useSettings } from '@entities/AppConfig';
import { ResizeHandle } from '@shared/ui/resize-handle';
import styles from './ChatPage.module.scss';

const PREVIEW_WIDTH_KEY = 'claude-control:preview-width';

/** Примеры под рукой: пустой чат не должен встречать пустотой. */
const SUGGESTIONS = ['page', 'explain', 'summarize'] as const;

/** Быстрые действия в пустом чате проекта: щелчок подставляет готовый запрос. */
const PROJECT_ACTIONS = ['review', 'bugs', 'structure', 'tests'] as const;

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
  const queryClient = useQueryClient();

  const [activeChat, setActiveChat] = useState<ChatSummary | undefined>(undefined);
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<Artifact | undefined>(undefined);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [previewWidth, setPreviewWidth] = useState(
    () => Number(localStorage.getItem(PREVIEW_WIDTH_KEY)) || 520,
  );
  // Тумблер прав хранится в chatPrefs (localStorage): по умолчанию правки
  // разрешены и не слетают после перезагрузки.
  const { allowEdits, setAllowEdits } = useChatPrefs();
  const [homeSection, setHomeSection] = useState<'chats' | 'projects'>('chats');
  const [isFolderPickerOpen, setFolderPickerOpen] = useState(false);
  const [isParallelOpen, setParallelOpen] = useState(false);
  const openEditor = useOpenInEditor();
  const { data: settings } = useSettings();
  const costUnit = settings?.costUnit ?? 'tokens';

  const chatId = activeChat?.id ?? draftId;

  const chats = useChats();
  const projects = useProjects();
  const ws = useWorkspace();
  const projectStatuses = useProjectStatuses();
  const activeRuns = useActiveRuns();
  const totalCost = useTotalCost();
  const totalTokens = useTotalTokens();

  // Прогон активного чата: текст, инструменты и статус. Фоновые прогоны других
  // чатов живут в том же сторе и продолжаются независимо.
  const run = useAgentRun(chatId);
  const isRunning = run.status === 'running';
  const stream: StreamState = useMemo(
    () => ({
      text: run.text,
      thinking: run.thinking,
      tools: run.tools,
      isRunning,
      error: run.error,
      sessionId: run.sessionId,
      costUsd: run.costUsd,
      limitResetsAt: run.limitResetsAt,
    }),
    [run, isRunning],
  );

  const projectPath =
    ws.activeProject?.path ??
    (activeChat && !activeChat.isSandbox ? activeChat.projectPath : undefined);
  const isProjectContext = Boolean(projectPath);

  // Черновик поля ввода: у каждого разговора/проекта/домашнего чата — свой
  // невыпущенный текст, который переживает перезагрузку страницы (localStorage).
  // Ключ строим по контексту: существующий чат — по id, черновик проекта — по
  // пути (стабилен между перезагрузками, в отличие от временного `new-…`).
  const draftKey = activeChat
    ? `chat:${activeChat.id}`
    : projectPath
      ? `project:${normalizeProjectPath(projectPath)}`
      : 'home';
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

  const writeUrl = useEntityUrlWriter();
  useEntityUrl<ChatSummary>({
    items: chats.data,
    getId: (chat) => chat.id,
    onOpen: (chat) => {
      setActiveChat(chat);
      setDraftId(undefined);
    },
  });
  const messages = useChatMessages(activeChat?.id);
  const artifacts = useArtifacts(chatId);
  const refresh = useRefreshChat(chatId);

  const finishedAt = useRef(0);

  // Любой завершившийся прогон освежает список чатов: там появляются новые
  // разговоры и обновляются заголовки — в том числе у фоновых агентов.
  useEffect(() => {
    agentRuns.setOnFinished(() => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    });
    return () => agentRuns.setOnFinished(undefined);
  }, [queryClient]);

  // После перезагрузки страницы подхватываем прогоны, что ещё идут на сервере, —
  // их живой вывод и цветные точки на табах возвращаются сами, без повторной
  // отправки. Один раз при входе на страницу чата.
  useEffect(() => {
    void agentRuns.resumeActive();
  }, []);

  // Открытый чат — чтобы стор не уведомлял о его собственном завершении.
  useEffect(() => {
    agentRuns.setActiveId(chatId);
  }, [chatId]);

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
      if (getChatPrefs().sound) {
        playNotification(
          backgroundRun.status === 'error'
            ? 'error'
            : backgroundRun.status === 'waiting'
              ? 'waiting'
              : 'done',
        );
      }
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
      if (getChatPrefs().sound) playNotification('waiting');
    });
    return () => agentRuns.setOnPermissionRequest(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, chatId]);

  // Агент, за которым сейчас смотрим, задал вопрос или упал — тоже звук, чтобы
  // не пропустить момент, когда от тебя ждут ответа. Только переход из «работает»,
  // чтобы открытие уже ждущего чата не пищало.
  const prevStatusRef = useRef(run.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = run.status;
    if (prev !== 'running') return;
    if ((run.status === 'waiting' || run.status === 'error') && getChatPrefs().sound) {
      playNotification(run.status);
    }
  }, [run.status]);

  // Завершение прогона активного чата — перечитываем его переписку из истории.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      finishedAt.current = Date.now();
      window.setTimeout(() => refresh(), 500);
    }
    wasRunningRef.current = isRunning;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  const enterProjectDraft = useCallback(() => {
    setActiveChat(undefined);
    setDraftId(`new-${Date.now()}`);
    setPreview(undefined);
    setPending([]);
    // Поле не трогаем: заранее вписанного вопроса про проект больше нет, а свой
    // недописанный черновик проекта хук подгрузит сам по смене ключа контекста.
    writeUrl(undefined);
  }, [writeUrl]);

  // Просмотр конкретного прогона агента (клик в пульте): когда открытие проекта
  // сменит таб, эффект ниже покажет этот прогон, а не заведёт новый черновик.
  const pendingViewRef = useRef<string | undefined>(undefined);

  const showRun = useCallback(
    (runId: string) => {
      setActiveChat(undefined);
      setDraftId(runId);
      setPreview(undefined);
      setPending([]);
      writeUrl(undefined);
    },
    [writeUrl],
  );

  // Смена активного таба: вид сбрасываем, для проекта готовим новый разговор с
  // подсказкой. Фоновый прогон прежнего таба при этом НЕ трогаем — он идёт
  // дальше, а его точка остаётся на табе.
  const prevTabRef = useRef(ws.state.activeTabId);
  useEffect(() => {
    const tabId = ws.state.activeTabId;
    if (tabId === prevTabRef.current) return;
    prevTabRef.current = tabId;

    const project = ws.state.projectTabs.find((tab) => tab.id === tabId);
    if (project) {
      // Пришли смотреть конкретного агента — показываем его прогон.
      if (pendingViewRef.current) {
        showRun(pendingViewRef.current);
        pendingViewRef.current = undefined;
      } else {
        enterProjectDraft();
      }
    } else if (pendingViewRef.current) {
      // Просмотр домашнего прогона.
      showRun(pendingViewRef.current);
      pendingViewRef.current = undefined;
    } else {
      setActiveChat(undefined);
      setDraftId(undefined);
      setPreview(undefined);
      setPending([]);
      writeUrl(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.state.activeTabId]);

  // Новый чат становится настоящим после первого ответа: тогда Claude Code
  // выдаёт sessionId, и разговор находится в списке.
  useEffect(() => {
    const sessionId = run.sessionId;
    if (!sessionId || activeChat || isRunning) return;

    const created = chats.data?.find((chat) => chat.id === sessionId);
    if (!created) return;

    setActiveChat(created);
    setDraftId(undefined);
    writeUrl(created.id);
    refresh(created.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.sessionId, isRunning, chats.data, activeChat]);

  // Ответ живёт в двух местах: пока печатается — в потоке, после записи в
  // транскрипт — в истории. Как только история перечитана, потоковый дубль
  // прячем: у обычного ответа прогон убираем совсем, а у «вопроса»/ошибки
  // оставляем — чтобы жёлтая/красная точка не пропала.
  useEffect(() => {
    if (isRunning || !run.text) return;
    if (!finishedAt.current || messages.dataUpdatedAt <= finishedAt.current) return;
    if (!messages.data?.some((message) => message.role === 'assistant')) return;

    if (run.status === 'idle') agentRuns.clear(chatId ?? '');
    else agentRuns.quiet(chatId ?? '');
  }, [messages.dataUpdatedAt, messages.data, isRunning, run.text, run.status, chatId]);

  useEffect(() => {
    if (pending.length === 0 || !messages.data) return;
    const inHistory = new Set(
      messages.data.filter((message) => message.role === 'user').map(plainTextOf),
    );
    setPending((current) => current.filter((message) => !inHistory.has(plainTextOf(message))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.data]);

  const startNewChat = (): void => {
    setActiveChat(undefined);
    setDraftId(`new-${Date.now()}`);
    setPreview(undefined);
    setPending([]);
    writeUrl(undefined);
  };

  const openChat = (chat: ChatSummary): void => {
    setActiveChat(chat);
    setDraftId(undefined);
    setPreview(undefined);
    setPending([]);
    writeUrl(chat.id);
  };

  const openProject = (project: ProjectInfo): void => {
    const wasActive = ws.activeProject?.id === normalizeProjectPath(project.path);
    ws.openProject(project.path, project.name);
    if (wasActive) enterProjectDraft();
  };

  // Клик по агенту в пульте: показать его живой поток в главном чате. Если агент
  // в проекте — открываем таб (эффект смены таба подхватит pendingViewRef и
  // покажет прогон); если уже в этом табе — показываем сразу.
  const viewRun = (activeRun: ActiveRunView): void => {
    if (activeRun.projectPath) {
      const id = normalizeProjectPath(activeRun.projectPath);
      if (ws.activeProject?.id === id) {
        showRun(activeRun.id);
      } else {
        pendingViewRef.current = activeRun.id;
        ws.openProject(activeRun.projectPath, projectShortName(activeRun.projectPath));
      }
    } else {
      // Домашний прогон — переходим на домашний таб и показываем его.
      if (!ws.isHome) {
        pendingViewRef.current = activeRun.id;
        ws.activate(HOME_TAB_ID);
      } else {
        showRun(activeRun.id);
      }
    }
  };

  // Папка, выбранная через файловую систему: открываем её как проект, даже если
  // Claude там ещё не работал (в истории её нет — таб всё равно заведётся).
  const openProjectPath = (path: string, name: string): void => {
    const wasActive = ws.activeProject?.id === normalizeProjectPath(path);
    ws.openProject(path, name);
    if (wasActive) enterProjectDraft();
    setFolderPickerOpen(false);
  };

  // Один запрос в нескольких проектах разом: в каждом открываем таб и стартуем
  // свой прогон. Они идут в фоне, а следить за ними — по точкам и в пульте.
  const launchParallel = (selected: ProjectInfo[], prompt: string, editsAllowed: boolean): void => {
    const stamp = Date.now();
    selected.forEach((project, index) => {
      ws.openProject(project.path, project.name);
      agentRuns.start({
        chatId: `new-${stamp}-${index}`,
        prompt,
        projectPath: project.path,
        allowEdits: editsAllowed,
        model: effectiveModel,
        effort: effectiveEffort,
      });
    });
    setParallelOpen(false);
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
  };

  const hasContent =
    (messages.data?.length ?? 0) > 0 ||
    pending.length > 0 ||
    messages.isLoading ||
    isRunning ||
    Boolean(run.text) ||
    Boolean(run.error);

  // Общий путь отправки: и для поля ввода, и для клика по варианту вопроса.
  // Показываем реплику сразу (pending), продолжаем существующую сессию.
  const dispatch = (prompt: string, files: { name: string; base64: string }[]): void => {
    let id = chatId;
    if (!id) {
      id = `new-${Date.now()}`;
      setDraftId(id);
    }

    setPending((current) => [
      ...current,
      {
        id: `pending-${Date.now()}`,
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        timestamp: new Date().toISOString(),
      },
    ]);

    agentRuns.start({
      chatId: id,
      prompt,
      // Продолжаем существующую сессию; у нового чата её ещё нет.
      sessionId: activeChat?.id ?? run.sessionId,
      files,
      allowEdits,
      // Модель и глубина: дефолт из настроек или локальный оверрайд чата.
      model: effectiveModel,
      effort: effectiveEffort,
      // Каталог проекта: серверу — рабочая папка нового чата, стору — группировка
      // статусов. У продолжения сессии рабочая папка уже известна.
      projectPath,
    });
  };

  const send = (files: { name: string; base64: string }[]): void => {
    const prompt = input.trim();
    if (!prompt) return;
    setInput('');
    dispatch(prompt, files);
  };

  // Клик по варианту в карточке вопроса: отвечаем этим вариантом, продолжая тот
  // же разговор — выбрать можно прямо в чате, не уходя в терминал. Пока агент
  // занят, отвечать нельзя (кнопки уже недоступны, но подстрахуемся).
  const answerQuestion = (answer: string): void => {
    const prompt = answer.trim();
    if (!prompt || isRunning) return;
    dispatch(prompt, []);
  };

  return (
    <div className={styles.shell}>
      {ws.state.projectTabs.length > 0 && (
        <WorkspaceTabs
          projectTabs={ws.state.projectTabs}
          activeTabId={ws.state.activeTabId}
          statuses={projectStatuses}
          onActivate={ws.activate}
          onClose={ws.closeProject}
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
        <div className={styles.sidebar}>
          {ws.isHome && (
            <div className={styles.segment} role="tablist" aria-label={t('projects.sidebarLabel')}>
              <button
                type="button"
                role="tab"
                aria-selected={homeSection === 'chats'}
                className={`${styles.segmentButton} ${homeSection === 'chats' ? styles.segmentActive : ''}`}
                onClick={() => setHomeSection('chats')}
              >
                {t('chat.title')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={homeSection === 'projects'}
                className={`${styles.segmentButton} ${homeSection === 'projects' ? styles.segmentActive : ''}`}
                onClick={() => setHomeSection('projects')}
              >
                {t('projects.title')}
              </button>
            </div>
          )}

          <div className={styles.sidebarList}>
            {ws.isHome && homeSection === 'projects' ? (
              <ProjectList
                projects={projects.data ?? []}
                isLoading={projects.isLoading}
                activeId={ws.activeProject?.id}
                statuses={projectStatuses}
                onOpen={openProject}
                onAddFolder={() => setFolderPickerOpen(true)}
                onParallelLaunch={() => setParallelOpen(true)}
              />
            ) : (
              <ChatList
                chats={visibleChats}
                isLoading={chats.isLoading}
                activeId={activeChat?.id}
                onSelect={openChat}
                onCreate={
                  ws.activeProject ? () => ws.activeProject && enterProjectDraft() : startNewChat
                }
              />
            )}
          </div>
        </div>

        <div className={styles.main}>
          <div className={styles.header}>
            <Stack gap="var(--spacing-3xs)" className={styles.headerText}>
              <Typography variant="body" weight="medium" className={styles.title}>
                {activeChat?.title ?? ws.activeProject?.name ?? t('chat.newChat')}
              </Typography>
              <Typography variant="caption" color="subtle" as="span" className={styles.title}>
                {projectPath ?? t('chat.sandboxHint')}
              </Typography>
            </Stack>

            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              {/* Шапки PageHeader здесь нет — ссылку на справку ставим рядом с пультом. */}
              <Link
                to={HELP_ROUTE}
                search={{ topic: 'chat' }}
                className={styles.help}
                title={t('help.common.openHelp')}
                aria-label={t('help.common.openHelp')}
              >
                <Icon name="help" size={24} />
              </Link>

              <AgentsPanel
                activeRuns={activeRuns}
                totalCost={totalCost}
                totalTokens={totalTokens}
                costUnit={costUnit}
                onStop={agentRuns.stop}
                onStopAll={agentRuns.stopAll}
                onView={viewRun}
              />

              <ChatModelPicker
                model={modelOverride}
                effort={effortOverride}
                defaultModel={defaultModel}
                defaultEffort={defaultEffort}
                onModelChange={setModelOverride}
                onEffortChange={setEffortOverride}
              />

              {isProjectContext && projectPath && (
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="scripts" size={20} />}
                  isLoading={openEditor.isPending}
                  onClick={() => openEditor.mutate(projectPath)}
                >
                  {t('projects.openInEditor')}
                </Button>
              )}

              {isProjectContext && (
                <label className={styles.editsToggle}>
                  <Toggle
                    size="sm"
                    checked={allowEdits}
                    onCheckedChange={setAllowEdits}
                    aria-label={t('chat.allowEdits')}
                  />
                  <Typography variant="caption" color={allowEdits ? 'default' : 'subtle'} as="span">
                    {allowEdits ? t('chat.editsAllowed') : t('chat.readOnly')}
                  </Typography>
                </label>
              )}

              {run.status === 'error' && chatId && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Icon name="refresh" size={18} />}
                    onClick={() => agentRuns.retry(chatId)}
                    title={t('chat.retryHint')}
                  >
                    {t('chat.retry')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => dispatch(t('chat.continueWord'), [])}
                    title={t('chat.continueHint')}
                  >
                    {t('chat.continue')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => agentRuns.retry(chatId, { fullAccess: true })}
                    title={t('chat.allowAndContinueHint')}
                  >
                    {t('chat.allowAndContinue')}
                  </Button>
                </>
              )}
              {(run.tokens > 0 || run.costUsd !== undefined) && (
                <Badge tone="neutral">{formatSpend(costUnit, run.tokens, run.costUsd ?? 0)}</Badge>
              )}
              {run.limitResetsAt !== undefined && (
                <Badge tone="info">
                  {t('chat.limitResets', { time: formatTime(run.limitResetsAt) })}
                </Badge>
              )}
              <Button
                variant="ghost"
                iconOnly
                icon={<Icon name="refresh" size={24} />}
                aria-label={t('common.refresh')}
                onClick={() => refresh()}
              />
            </Stack>
          </div>

          {(artifacts.data?.length ?? 0) > 0 && (
            <div className={styles.artifacts} data-artifacts>
              {artifacts.data?.map((artifact) => (
                <Button
                  key={artifact.name}
                  size="sm"
                  variant="ghost"
                  leftIcon={<Icon name="file" size={20} />}
                  onClick={() => setPreview(artifact)}
                >
                  {artifact.name}
                </Button>
              ))}
            </div>
          )}

          {hasContent ? (
            <ChatMessages
              messages={[...(messages.data ?? []), ...pending]}
              stream={stream}
              isLoading={messages.isLoading}
              onEdit={setInput}
              onPickOption={answerQuestion}
              isRunning={isRunning}
              permissions={run.permissions}
              onPermissionDecide={(toolUseId, behavior) =>
                chatId && agentRuns.decidePermission(chatId, toolUseId, behavior)
              }
            />
          ) : (
            <div className={styles.empty}>
              <Stack gap="var(--spacing-sm)" align="center" className={styles.emptyBox}>
                <Icon name={isProjectContext ? 'folder' : 'chat'} size={40} />
                <Typography variant="heading-sm">
                  {isProjectContext
                    ? (ws.activeProject?.name ?? t('chat.newChat'))
                    : t('chat.emptyTitle')}
                </Typography>

                {isProjectContext ? (
                  <>
                    <Typography as="span" className={styles.projectIntro}>
                      {projectPath}
                    </Typography>
                    <Typography color="muted" className={styles.emptyText}>
                      {t('projects.introHint')}
                    </Typography>
                    <div className={styles.suggestions}>
                      {projectPath && (
                        <button
                          type="button"
                          className={`${styles.suggestion} ${styles.suggestionAction}`}
                          onClick={() => openEditor.mutate(projectPath)}
                        >
                          <Icon name="scripts" size={16} />
                          {t('projects.openInEditor')}
                        </button>
                      )}
                      {PROJECT_ACTIONS.map((key) => (
                        <button
                          key={key}
                          type="button"
                          className={styles.suggestion}
                          onClick={() => setInput(t(`projects.actions.${key}`))}
                        >
                          {t(`projects.actions.${key}`)}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <Typography color="muted" className={styles.emptyText}>
                      {t('chat.emptyText')}
                    </Typography>
                    <div className={styles.suggestions}>
                      {SUGGESTIONS.map((key) => (
                        <button
                          key={key}
                          type="button"
                          className={styles.suggestion}
                          onClick={() => setInput(t(`chat.suggestions.${key}`))}
                        >
                          {t(`chat.suggestions.${key}`)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </Stack>
            </div>
          )}

          <ChatComposer
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={() => chatId && agentRuns.stop(chatId)}
            isRunning={isRunning}
          />
        </div>

        {preview && chatId && (
          <>
            <ResizeHandle
              width={previewWidth}
              min={320}
              max={1000}
              label={t('chat.resizePreview')}
              onResize={(width) => {
                setPreviewWidth(width);
                localStorage.setItem(PREVIEW_WIDTH_KEY, String(width));
              }}
            />
            <ArtifactPreview
              chatId={chatId}
              artifact={preview}
              onClose={() => setPreview(undefined)}
            />
          </>
        )}
      </div>

      <FolderPicker
        isOpen={isFolderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onPick={openProjectPath}
      />

      <ParallelLaunch
        isOpen={isParallelOpen}
        onOpenChange={setParallelOpen}
        projects={projects.data ?? []}
        onLaunch={launchParallel}
      />
    </div>
  );
}

/** Текст реплики без разметки блоков — по нему сверяем своё сообщение с историей. */
function plainTextOf(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text.trim() : ''))
    .join('\n')
    .trim();
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Короткое имя проекта из пути — для тоста-уведомления о фоновом агенте. */
function projectShortName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
