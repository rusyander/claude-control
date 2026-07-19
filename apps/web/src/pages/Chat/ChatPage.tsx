import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { Artifact, ChatMessage, ChatSummary } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useWorkspace, normalizeProjectPath } from '@shared/lib/workspace';
import { agentRuns, useAgentRun, useProjectStatuses } from '@shared/lib/agent-runs';
import { ChatList } from '@features/ChatList';
import { ProjectList } from '@features/ProjectList';
import { WorkspaceTabs } from '@features/WorkspaceTabs';
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
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<Artifact | undefined>(undefined);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [previewWidth, setPreviewWidth] = useState(
    () => Number(localStorage.getItem(PREVIEW_WIDTH_KEY)) || 520,
  );
  const [allowEdits, setAllowEdits] = useState(false);
  const [homeSection, setHomeSection] = useState<'chats' | 'projects'>('chats');
  const [isFolderPickerOpen, setFolderPickerOpen] = useState(false);
  const openEditor = useOpenInEditor();

  const chatId = activeChat?.id ?? draftId;

  const chats = useChats();
  const projects = useProjects();
  const ws = useWorkspace();
  const projectStatuses = useProjectStatuses();

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

  const enterProjectDraft = useCallback(
    (project: { name: string }) => {
      setActiveChat(undefined);
      setDraftId(`new-${Date.now()}`);
      setPreview(undefined);
      setPending([]);
      setAllowEdits(false);
      setInput(t('projects.starterPrompt', { name: project.name }));
      writeUrl(undefined);
    },
    [t, writeUrl],
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
      enterProjectDraft(project);
    } else {
      setActiveChat(undefined);
      setDraftId(undefined);
      setPreview(undefined);
      setPending([]);
      setAllowEdits(false);
      setInput('');
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
    setAllowEdits(false);
    setInput('');
    writeUrl(undefined);
  };

  const openChat = (chat: ChatSummary): void => {
    setActiveChat(chat);
    setDraftId(undefined);
    setPreview(undefined);
    setPending([]);
    setAllowEdits(false);
    writeUrl(chat.id);
  };

  const openProject = (project: ProjectInfo): void => {
    const wasActive = ws.activeProject?.id === normalizeProjectPath(project.path);
    ws.openProject(project.path, project.name);
    if (wasActive) enterProjectDraft(project);
  };

  // Папка, выбранная через файловую систему: открываем её как проект, даже если
  // Claude там ещё не работал (в истории её нет — таб всё равно заведётся).
  const openProjectPath = (path: string, name: string): void => {
    const wasActive = ws.activeProject?.id === normalizeProjectPath(path);
    ws.openProject(path, name);
    if (wasActive) enterProjectDraft({ name });
    setFolderPickerOpen(false);
  };

  const hasContent =
    (messages.data?.length ?? 0) > 0 ||
    pending.length > 0 ||
    messages.isLoading ||
    isRunning ||
    Boolean(run.text) ||
    Boolean(run.error);

  const send = (files: { name: string; base64: string }[]): void => {
    const prompt = input.trim();
    if (!prompt) return;

    let id = chatId;
    if (!id) {
      id = `new-${Date.now()}`;
      setDraftId(id);
    }

    setInput('');
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
      // Каталог проекта: серверу — рабочая папка нового чата, стору — группировка
      // статусов. У продолжения сессии рабочая папка уже известна.
      projectPath,
    });
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
              />
            ) : (
              <ChatList
                chats={visibleChats}
                isLoading={chats.isLoading}
                activeId={activeChat?.id}
                onSelect={openChat}
                onCreate={
                  ws.activeProject
                    ? () => ws.activeProject && enterProjectDraft(ws.activeProject)
                    : startNewChat
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

              {run.costUsd !== undefined && <Badge tone="neutral">${run.costUsd.toFixed(3)}</Badge>}
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
