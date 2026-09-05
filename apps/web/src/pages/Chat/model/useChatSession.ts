import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Artifact, ChatMessage, ChatSummary } from '@claude-control/contracts';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import {
  useWorkspace,
  workspace,
  getWorkspaceState,
  normalizeProjectPath,
  projectShortName,
  HOME_TAB_ID,
} from '@shared/lib/workspace';
import { useAgentRun } from '@shared/lib/agent-runs';
import { migrateDraft } from '@shared/lib/draft';
import { useRefreshChat } from '@entities/Chat';
import type { ProjectInfo } from '@entities/Project';
import { useClearRunnerAutostart } from '@entities/ProjectRunner';
import { useForgetProjectCodeView } from '@entities/ProjectFile';
import { draftKeyFor } from '../lib/draftKey';
import { visibleChats } from '../lib/visibleChats';

export interface ChatSessionInput {
  /** Все разговоры из истории Claude Code — по ним находится «повзрослевший» чат. */
  chats?: ChatSummary[];
}

/**
 * Куда переключить главную колонку. Нарочно уже, чем `ActiveRunView`: показывать
 * приходится не только живой прогон из пульта, но и разговор, только что
 * заведённый продолжением в чистой сессии, — у того нет ни статуса, ни расхода,
 * а путь и ключ есть.
 */
export interface ViewTarget {
  id: string;
  projectPath?: string;
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
  /** Открыть разговор по ключу — когда на руках только id, а не сам чат. */
  openChatById: (id: string) => void;
  openProject: (project: ProjectInfo) => void;
  openProjectPath: (path: string, name: string) => void;
  viewRun: (run: ViewTarget) => void;
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
  const forgetCodeView = useForgetProjectCodeView();

  const chatId = activeChat?.id ?? draftId;
  const run = useAgentRun(chatId);
  const isRunning = run.status === 'running';
  const refresh = useRefreshChat(chatId);

  // Каталог разговора важнее каталога вкладки, а не наоборот. Разделение задач
  // заводит детей в КОПИЯХ репозитория, но показывает их деревом в той же
  // вкладке, где человек согласился делить, — и прогон, пульт git и окно кода
  // обязаны смотреть в каталог ОТКРЫТОГО ЧАТА, иначе ответ ребёнку ушёл бы
  // работать в родительскую копию. Черновик проекта чата не имеет — тогда
  // каталог даёт вкладка.
  const projectPath =
    (activeChat && !activeChat.isSandbox ? activeChat.projectPath : undefined) ??
    ws.activeProject?.path;
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
    const draft = `new-${Date.now()}`;
    setDraftId(draft);
    setPreview(undefined);
    setPending([]);
    // Черновик тоже запоминаем за вкладкой: с него начинается разговор, и если
    // в нём уже пошёл прогон, возврат на вкладку обязан показать именно его.
    workspace.rememberView(getWorkspaceState().activeTabId, draft);
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
      workspace.rememberView(getWorkspaceState().activeTabId, runId);
      writeUrl(undefined);
    },
    [writeUrl],
  );

  /**
   * Разговор, который вкладка должна показать, когда список чатов доедет.
   * Запомненный id приходит из хранилища раньше самих чатов, а без записи в
   * списке он неотличим от черновика — поэтому ждём и доводим потом.
   */
  const restoreRef = useRef<string | undefined>(undefined);

  /** Открыть запомненный разговор: настоящий — из списка, иначе как черновик. */
  const restoreView = useCallback(
    (wanted: string, known: ChatSummary[] | undefined): void => {
      const found = known?.find((chat) => chat.id === wanted);
      if (found) {
        restoreRef.current = undefined;
        setActiveChat(found);
        setDraftId(undefined);
        setPreview(undefined);
        setPending([]);
        writeUrl(found.id);
        return;
      }
      // Списка ещё нет — покажем как черновик (живой прогон под этим id виден
      // сразу), а эффект ниже доведёт до настоящего разговора, когда список придёт.
      restoreRef.current = wanted;
      showRun(wanted);
    },
    [showRun, writeUrl],
  );

  useEffect(() => {
    const wanted = restoreRef.current;
    if (!wanted || !chats) return;
    const found = chats.find((chat) => chat.id === wanted);
    if (!found) return;
    restoreRef.current = undefined;
    setActiveChat(found);
    setDraftId(undefined);
    writeUrl(found.id);
  }, [chats, writeUrl]);

  // Смена активного таба: вид сбрасываем, для проекта готовим новый разговор с
  // подсказкой. Фоновый прогон прежнего таба при этом НЕ трогаем — он идёт
  // дальше, а его точка остаётся на табе.
  const prevTabRef = useRef(ws.state.activeTabId);
  useEffect(() => {
    const tabId = ws.state.activeTabId;
    if (tabId === prevTabRef.current) return;
    prevTabRef.current = tabId;

    // Пришли смотреть конкретного агента (клик в пульте) — он важнее памяти
    // вкладки: человек только что назвал, что хочет видеть.
    if (pendingViewRef.current) {
      showRun(pendingViewRef.current);
      pendingViewRef.current = undefined;
      return;
    }

    // Вкладка помнит свой разговор — возвращаем именно его. Это и есть работа с
    // несколькими агентами разом: ушёл в другую вкладку, вернулся — на месте.
    const remembered = getWorkspaceState().views[tabId];
    if (remembered) {
      restoreView(remembered, chats);
      return;
    }

    const project = ws.state.projectTabs.find((tab) => tab.id === tabId);
    if (project) {
      enterProjectDraft();
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
    // Вкладка помнила черновик — теперь помнит настоящий разговор, иначе после
    // возврата открылся бы пустой лист вместо только что состоявшегося ответа.
    workspace.rememberView(getWorkspaceState().activeTabId, created.id);
    writeUrl(created.id);
    refresh(created.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.sessionId, isRunning, chats, activeChat]);

  const startNewChat = (): void => {
    setActiveChat(undefined);
    const draft = `new-${Date.now()}`;
    setDraftId(draft);
    setPreview(undefined);
    setPending([]);
    workspace.rememberView(getWorkspaceState().activeTabId, draft);
    writeUrl(undefined);
  };

  const openChat = (chat: ChatSummary): void => {
    setActiveChat(chat);
    setDraftId(undefined);
    setPreview(undefined);
    setPending([]);
    restoreRef.current = undefined;
    workspace.rememberView(getWorkspaceState().activeTabId, chat.id);
    writeUrl(chat.id);
  };

  /**
   * Открыть разговор по одному лишь ключу. Нужно там, где id приходит от
   * механизма, а не от клика по списку: уведомление о ребёнке, переезд в
   * продолженную сессию. Разговоры хук и так держит — искать их снаружи значило
   * бы носить весь список за собой ради одной строки.
   */
  const openChatById = (id: string): void => {
    const found = (chats ?? []).find((chat) => chat.id === id);
    if (found) openChat(found);
  };

  const openProject = (project: ProjectInfo): void => {
    const wasActive = ws.activeProject?.id === normalizeProjectPath(project.path);
    ws.openProject(project.path, project.name);
    if (wasActive) enterProjectDraft();
  };

  // Клик по агенту в пульте: показать его живой поток в главном чате. Если агент
  // в проекте — открываем таб (эффект смены таба подхватит pendingViewRef и
  // покажет прогон); если уже в этом табе — показываем сразу.
  const viewRun = (activeRun: ViewTarget): void => {
    // Ребёнок разделения работает в копии репозитория, но показан деревом в
    // ЭТОЙ вкладке: открывать ради него отдельный проект — значит вернуть ряд
    // одинаковых вкладок, от которого ушли. Видно здесь — открываем здесь, и
    // каталог берётся из самого разговора.
    const child = chats?.find((chat) => chat.id === activeRun.id && chat.parentId);
    if (child && visibleChats(chats ?? [], ws.activeProject?.id).some((c) => c.id === child.id)) {
      openChat(child);
      return;
    }

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
   *
   * Тем же движением забываем, что было открыто в окне кода этого проекта:
   * снимок дерева и файла живёт РОВНО столько, сколько открыт таб, — так
   * договорились. Закрыли вкладку — вернулись к чистому листу.
   */
  const closeProjectTab = (id: string): void => {
    const tab = ws.state.projectTabs.find((item) => item.id === id);
    if (tab) {
      clearRunnerAutostart.mutate({ path: tab.path });
      forgetCodeView.mutate({ path: tab.path });
    }
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
    openChatById,
    openProject,
    openProjectPath,
    viewRun,
    closeProjectTab,
  };
}
