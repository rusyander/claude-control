import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Artifact, ChatMessage, ChatSummary } from '@claude-control/contracts';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import {
  useWorkspace,
  normalizeProjectPath,
  projectShortName,
  HOME_TAB_ID,
} from '@shared/lib/workspace';
import { useAgentRun, type ActiveRunView } from '@shared/lib/agent-runs';
import { migrateDraft } from '@shared/lib/draft';
import { useRefreshChat } from '@entities/Chat';
import type { ProjectInfo } from '@entities/Project';
import { useClearRunnerAutostart } from '@entities/ProjectRunner';
import { draftKeyFor } from '../lib/draftKey';

export interface ChatSessionInput {
  /** Все разговоры из истории Claude Code — по ним находится «повзрослевший» чат. */
  chats?: ChatSummary[];
}

export interface ChatSession {
  activeChat?: ChatSummary;
  draftId?: string;
  setDraftId: Dispatch<SetStateAction<string | undefined>>;
  /** Существующий разговор или черновик — под этим ключом живёт прогон. */
  chatId?: string;
  /** Каталог проекта разговора; пусто — песочница. */
  projectPath?: string;
  isProjectContext: boolean;
  /** Ключ контекста для черновиков поля ввода и пер-чат оверрайдов. */
  draftKey: string;
  preview?: Artifact;
  setPreview: Dispatch<SetStateAction<Artifact | undefined>>;
  pending: ChatMessage[];
  setPending: Dispatch<SetStateAction<ChatMessage[]>>;
  refresh: (id?: string) => void;
  enterProjectDraft: () => void;
  startNewChat: () => void;
  openChat: (chat: ChatSummary) => void;
  openProject: (project: ProjectInfo) => void;
  openProjectPath: (path: string, name: string) => void;
  viewRun: (run: ActiveRunView) => void;
  closeProjectTab: (id: string) => void;
}

/**
 * Какой разговор открыт и в каком каталоге он идёт: активный чат, черновик,
 * предпросмотр артефакта, оптимистичные реплики и все переходы между ними —
 * клик по списку, смена таба, открытие папки, просмотр чужого прогона.
 *
 * Здесь же разговор «взрослеет»: новый чат становится настоящим, когда Claude
 * Code выдаёт sessionId, и вместе с ним на новый ключ переезжают черновики.
 */
export function useChatSession({ chats }: ChatSessionInput): ChatSession {
  const [activeChat, setActiveChat] = useState<ChatSummary | undefined>(undefined);
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<Artifact | undefined>(undefined);
  const [pending, setPending] = useState<ChatMessage[]>([]);

  const ws = useWorkspace();
  const writeUrl = useEntityUrlWriter();
  const clearRunnerAutostart = useClearRunnerAutostart();

  const chatId = activeChat?.id ?? draftId;
  const run = useAgentRun(chatId);
  const isRunning = run.status === 'running';
  const refresh = useRefreshChat(chatId);

  const projectPath =
    ws.activeProject?.path ??
    (activeChat && !activeChat.isSandbox ? activeChat.projectPath : undefined);
  const isProjectContext = Boolean(projectPath);

  // Черновик поля ввода: у каждого разговора/проекта/домашнего чата — свой
  // невыпущенный текст, который переживает перезагрузку страницы (localStorage).
  const draftKey = draftKeyFor(activeChat, projectPath);

  useEntityUrl<ChatSummary>({
    items: chats,
    getId: (chat) => chat.id,
    onOpen: (chat) => {
      setActiveChat(chat);
      setDraftId(undefined);
    },
  });

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

    const created = chats?.find((chat) => chat.id === sessionId);
    if (!created) return;

    // Ключ контекста меняется с `home`/`project:…` на `chat:<id>`. Переносим на
    // новый ключ пер-чат оверрайд модели/усилия и недописанный черновик — иначе
    // следующее сообщение в этом же чате молча вернётся к дефолтам из настроек.
    const nextKey = `chat:${created.id}`;
    migrateDraft(draftKey, nextKey);
    migrateDraft(`chat-model:${draftKey}`, `chat-model:${nextKey}`);
    migrateDraft(`chat-effort:${draftKey}`, `chat-effort:${nextKey}`);

    setActiveChat(created);
    setDraftId(undefined);
    writeUrl(created.id);
    refresh(created.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.sessionId, isRunning, chats, activeChat]);

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
    } else if (!ws.isHome) {
      // Домашний прогон — переходим на домашний таб, эффект смены таба покажет его.
      pendingViewRef.current = activeRun.id;
      ws.activate(HOME_TAB_ID);
    } else {
      showRun(activeRun.id);
    }
  };

  // Папка, выбранная через файловую систему: открываем её как проект, даже если
  // Claude там ещё не работал (в истории её нет — таб всё равно заведётся).
  const openProjectPath = (path: string, name: string): void => {
    const wasActive = ws.activeProject?.id === normalizeProjectPath(path);
    ws.openProject(path, name);
    if (wasActive) enterProjectDraft();
  };

  /**
   * Закрыть вкладку проекта. Заодно снимаем автозапуск со ВСЕХ его целей: у
   * монорепы их несколько, а вкладку закрыли — значит, при старте панели ничего
   * из этого проекта подниматься не должно. Отказ сервера здесь не мешает
   * закрыть вкладку: тумблеры видны в самой вкладке, и человек поправит их,
   * когда откроет проект снова.
   */
  const closeProjectTab = (id: string): void => {
    const tab = ws.state.projectTabs.find((item) => item.id === id);
    if (tab) clearRunnerAutostart.mutate({ path: tab.path });
    ws.closeProject(id);
  };

  return {
    activeChat,
    draftId,
    setDraftId,
    chatId,
    projectPath,
    isProjectContext,
    draftKey,
    preview,
    setPreview,
    pending,
    setPending,
    refresh,
    enterProjectDraft,
    startNewChat,
    openChat,
    openProject,
    openProjectPath,
    viewRun,
    closeProjectTab,
  };
}
