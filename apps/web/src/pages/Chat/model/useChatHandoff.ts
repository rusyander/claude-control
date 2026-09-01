import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { HandoffProposal } from '@claude-control/contracts/chat-handoff';
import { HANDOFF_MAX_CHAIN, contextHandoffProposal } from '@claude-control/contracts/chat-handoff';
import {
  workspace,
  getWorkspaceState,
  projectShortName,
  normalizeProjectPath,
} from '@shared/lib/workspace';
import { agentRuns } from '@shared/lib/agent-runs';
import { saveDraft } from '@shared/lib/draft';
import { toast } from '@shared/lib/toast';
import { chatKeys } from '@entities/Chat';
import {
  useStartHandoff,
  fetchHandoffState,
  setHandoffAuto,
  fetchHandoffRequestPrompt,
} from '@entities/ChatHandoff';
import type { HandoffControls } from '@features/ChatMessages';
import type { ViewTarget } from './useChatSession';

export interface ChatHandoffInput {
  /** Каталог разговора: продолжать без проекта некуда — карточка станет читальной. */
  projectPath?: string;
  /** Ключи текущего разговора: под ними на сервере живут тумблер и номер шага. */
  chatId?: string;
  sessionId?: string;
  /** Правки в проекте разрешены — тумблером из шапки; наследуются продолжением. */
  allowEdits: boolean;
  model: string;
  effort: string;
  /** Отправка готового текста в текущий разговор (просьба и отказ идут ею). */
  dispatch: (prompt: string, files: never[]) => Promise<boolean>;
  /** Показать разговор в главной колонке — им панель переезжает на продолжение. */
  showChat: (target: ViewTarget) => void;
}

export interface ChatHandoffApi {
  /** Кнопка «Закрыть этап»: просим агента подготовить продолжение. */
  askHandoff?: () => void;
  /** Всё, что нужно карточке в ленте; пусто — продолжать некуда (нет проекта). */
  controls?: HandoffControls;
}

/**
 * Продолжение работы в чистой сессии — сторона панели.
 *
 * Два пути к одному и тому же результату, и оба ведут в сервер: кнопка на
 * карточке (человек решил) и планировщик (панель продолжила сама, когда в
 * разговоре включён автомат). Здесь только показ и переезд вкладки — новый
 * разговор заводит сервер, потому что продолжать он должен и с закрытым
 * браузером.
 *
 * Тумблер автопродолжения тоже серверный и живёт у РАЗГОВОРА, а не в настройках:
 * включают его в тот момент, когда впервые видят, что именно панель собирается
 * сделать, — и ровно для этой работы, а не для всех сразу.
 */
export function useChatHandoff({
  projectPath,
  chatId,
  sessionId,
  allowEdits,
  model,
  effort,
  dispatch,
  showChat,
}: ChatHandoffInput): ChatHandoffApi {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const startHandoff = useStartHandoff();

  const [auto, setAuto] = useState(false);
  const [chainDepth, setChainDepth] = useState(0);
  const [maxChain, setMaxChain] = useState(HANDOFF_MAX_CHAIN);

  // Ключи открытого разговора и переключатель вида — для колбэка стора: он живёт
  // дольше рендера, и сравнивать «мой ли это прогон» по замыканию нельзя, оно
  // устареет. Ссылкой, а не зависимостью: `showChat` приходит новой функцией на
  // каждый рендер страницы, и колбэк переподписывался бы на каждую букву ответа.
  const openRef = useRef<{ chatId?: string; sessionId?: string }>({});
  openRef.current = { chatId, sessionId };
  const showRef = useRef(showChat);
  showRef.current = showChat;
  // Продолжение по клику в уведомлении о размере окна: колбэк стора переживает
  // рендер, поэтому берётся ссылкой — иначе он звал бы вчерашний разговор.
  const continueRef = useRef<(proposal: HandoffProposal) => void>(() => undefined);

  // Состояние цепочки приходит с сервера: тумблер обязан пережить и перезагрузку
  // вкладки, и открытие того же разговора с телефона.
  useEffect(() => {
    if (!chatId && !sessionId) {
      setAuto(false);
      setChainDepth(0);
      return;
    }
    let cancelled = false;
    void fetchHandoffState({ chatId, sessionId })
      .then((state) => {
        if (cancelled) return;
        setAuto(state.auto);
        setChainDepth(state.depth);
        setMaxChain(state.maxChain);
      })
      .catch(() => {
        // Молча: недоступное состояние цепочки — не повод для тоста поверх чата.
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, sessionId]);

  /** Переезд на заведённый разговор: вкладка, память вкладки и живой поток. */
  const adopt = useCallback(
    (started: { chatId: string; path: string; started: boolean; prompt: string }): void => {
      const tabId = workspace.openProject(started.path, projectShortName(started.path));
      workspace.rememberView(tabId, started.chatId);
      // Прогон не запускали — кладём задание в поле ввода. Ключ черновика у
      // разговора, которого ещё нет, строится по ПУТИ проекта (`draftKeyFor`).
      if (!started.started) {
        saveDraft(`project:${normalizeProjectPath(started.path)}`, started.prompt);
      }
      showRef.current({ id: started.chatId, projectPath: started.path });
      // Прогон завёл сервер, своего события у него нет: подхватываем поток сразу,
      // иначе несколько секунд разговор стоит без вывода и без точки.
      void agentRuns.resumeActive();
      void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    },
    [queryClient],
  );

  // Панель продолжила сама. Вкладку переключаем, ТОЛЬКО если смотрим на тот
  // разговор, который закрылся: утащить человека из другого проекта на чужое
  // продолжение — это потеря места, а не помощь. В остальных случаях тост с
  // переходом, а вкладка того проекта запоминает продолжение и покажет его,
  // когда на неё вернутся.
  useEffect(() => {
    agentRuns.setOnHandoff((event, run) => {
      if (event.reason) {
        const tokens = event.contextTokens ? Math.round(event.contextTokens / 1000) : 0;
        // Повод по размеру окна — единственный отказ, который человек может снять
        // одним движением, поэтому он не просто объявляется, а предлагается:
        // уведомление кликабельно, и клик заводит продолжение. Живёт дольше
        // обычных трёх секунд — на решение нужно время, но само уходит: висящее
        // на экране предложение хуже, чем повторённое на следующем ходу.
        if (event.reason === 'context_high' && event.contextTokens) {
          const size = event.contextTokens;
          toast.warning(t('chat.handoff.contextHigh', { tokens }), {
            duration: 15_000,
            onClick: () => continueRef.current(contextHandoffProposal(size)),
          });
          return;
        }
        if (event.reason === 'checkpoint_stale' && event.contextTokens) {
          toast.warning(t('chat.handoff.contextStale', { tokens }), { duration: 15_000 });
          return;
        }
        toast.warning(t(`chat.handoff.refusal.${event.reason}`));
        return;
      }
      if (!event.chatId || !event.path) return;

      const open = openRef.current;
      const isWatched = Boolean(
        (open.chatId && (run.id === open.chatId || run.sessionId === open.chatId)) ||
        (open.sessionId && run.sessionId === open.sessionId),
      );

      const path = event.path;
      const nextId = event.chatId;
      if (isWatched) {
        adopt({ chatId: nextId, path, started: true, prompt: '' });
        setChainDepth(event.chainDepth ?? 0);
      } else {
        const tabId = normalizeProjectPath(path);
        if (getWorkspaceState().projectTabs.some((tab) => tab.id === tabId)) {
          workspace.rememberView(tabId, nextId);
        }
        void agentRuns.resumeActive();
        void queryClient.invalidateQueries({ queryKey: chatKeys.list });
      }

      toast.success(t('chat.handoff.autoDone', { name: projectShortName(path) }), {
        onClick: () => showRef.current({ id: nextId, projectPath: path }),
      });
    });
    return () => agentRuns.setOnHandoff(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, adopt]);

  const askHandoff = (): void => {
    void fetchHandoffRequestPrompt()
      .then((prompt) => dispatch(prompt, []))
      .catch(() => toast.error(t('chat.handoff.askFailed')));
  };

  const keepHere = (): void => {
    void dispatch(t('chat.handoff.keepHerePrompt'), []);
  };

  const changeAuto = (enabled: boolean): void => {
    setAuto(enabled);
    void setHandoffAuto({ chatId, sessionId }, enabled)
      .then((state) => setAuto(state.auto))
      .catch(() => {
        // Сервер не принял — возвращаем тумблер, иначе человек уйдёт спать в
        // уверенности, что панель продолжит работу сама.
        setAuto(!enabled);
        toast.error(t('chat.handoff.autoFailed'));
      });
  };

  const continueHandoff = (proposal: HandoffProposal, options: { startRun: boolean }): void => {
    if (!projectPath) return;
    startHandoff.mutate(
      {
        projectPath,
        ...(chatId ? { chatId } : {}),
        ...(sessionId ? { sessionId } : {}),
        proposal,
        startRun: options.startRun,
        allowEdits,
        model,
        effort,
      },
      {
        onSuccess: (started) => {
          adopt(started);
          setChainDepth(started.chainDepth);
          toast.success(started.started ? t('chat.handoff.done') : t('chat.handoff.doneDraft'));
        },
        onError: (error) => {
          toast.error(t('chat.handoff.failed', { message: (error as Error).message }));
        },
      },
    );
  };

  continueRef.current = (proposal: HandoffProposal): void =>
    continueHandoff(proposal, { startRun: true });

  return {
    ...(projectPath ? { askHandoff } : {}),
    ...(projectPath
      ? {
          controls: {
            onContinue: continueHandoff,
            onKeepHere: keepHere,
            auto,
            onAutoChange: changeAuto,
            chainDepth,
            maxChain,
            isPending: startHandoff.isPending,
          },
        }
      : {}),
  };
}
