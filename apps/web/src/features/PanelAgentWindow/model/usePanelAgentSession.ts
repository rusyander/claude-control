import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import type {
  PanelAgentPageContext,
  PanelAgentRunRefusalCode,
} from '@agentdeck/contracts/panel-agent';
import { withAgentImagesNote, type AgentImage } from '@agentdeck/contracts/agent-images';
import { STREAM_LOST, fetchPanelAgentConversation, runPanelAgent } from '@entities/PanelAgent';
import { queryKeys } from '@shared/api/query-keys';
import {
  EMPTY_CONVERSATION,
  applyRunEvent,
  fromConversation,
  isOwnConversationEvent,
  reloadSettledConversation,
  withNotice,
  withReloadedConversation,
  withSealedTurnCaughtUp,
  withTurnAborted,
  withUserMessage,
  type ConversationState,
  type SealNote,
} from './conversation';
import {
  closeSkippedTurn,
  readWindowMemory,
  restoredConversation,
  sessionStore,
  writeWindowMemory,
} from './windowMemory';

/** Отказ хода: вкладка отстала от разговора — его продолжили в другой вкладке. */
const CONVERSATION_STALE: PanelAgentRunRefusalCode = 'conversation_stale';
/** Отказ хода: разговор удалили в другой вкладке — писать в него значит вернуть его. */
const CONVERSATION_DELETED: PanelAgentRunRefusalCode = 'conversation_deleted';

export interface PanelAgentSessionTexts {
  stopped: string;
  runFailed: (message: string) => string;
  /** Текст отказа по коду сервера; неизвестный код — пусто, тогда слова сервера. */
  refusal: (code: string) => string | undefined;
  /** Разговор вернулся после F5, а ход, шедший в тот момент, оборвался. */
  interruptedByReload: string;
  /** Поток хода замолчал (панель перезапустилась) — разговор перечитан с сервера. */
  streamLost: string;
  /** Вкладка отстала: разговор перечитан, неотправленный текст назван. */
  staleReloaded: (text: string) => string;
  /** Разговор удалили в другой вкладке: окно начинает новый, неотправленный текст назван. */
  deletedElsewhere: (text: string) => string;
  /** Пометка запечатанного ответа языком окна: в файле хвост английский, для модели. */
  sealNote?: SealNote;
}

export interface PanelAgentSessionOptions {
  /** После F5 вернулся разговор, чей ход оборвала перезагрузка: окно открыть. */
  onInterruptedRestore?: () => void;
}

/**
 * Разговор с агентом панели. Живёт в каркасе, а не в самом окне: окно
 * закрывают, чтобы посмотреть на открытую агентом страницу, и закрытие не
 * должно обрывать ход — обрыв запроса останавливает агента на сервере.
 */
export function usePanelAgentSession(
  texts: PanelAgentSessionTexts,
  options: PanelAgentSessionOptions = {},
) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConversationState>(EMPTY_CONVERSATION);
  const stateRef = useRef(state);
  stateRef.current = state;
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const textsRef = useRef(texts);
  textsRef.current = texts;

  // Страница уходит (F5, переход): её запрос хода обрывается, и конец хода,
  // увиденный уже при уходе, — не конец. Без метки память писала «ход кончился»
  // прямо перед перезагрузкой, и вернувшееся окно молчало об оборванном ходе
  // (живой прогон: заглушка потока этого не ловила — её поток уход не рвёт).
  const pageHidingRef = useRef(false);
  useEffect(() => {
    const onPageHide = (): void => {
      pageHidingRef.current = true;
    };
    const onPageShow = (): void => {
      pageHidingRef.current = false;
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  // Разговор вкладки переживает F5: он живёт в памяти страницы, и перезагрузка
  // выбрасывала его вместе с ходом и снятой карточкой — окно открывалось пустым.
  useEffect(() => {
    const memory = readWindowMemory(sessionStore());
    if (!memory) return undefined;
    let alive = true;
    void (async () => {
      // Сервер мог как раз перезапускаться: несколько попыток, прежде чем сдаться.
      for (let attempt = 0; attempt < 5 && alive; attempt += 1) {
        try {
          const conversation = await fetchPanelAgentConversation(memory.conversationId);
          if (!alive || stateRef.current.running) return;
          if (stateRef.current.feed.length > 0) {
            closeSkippedTurn(sessionStore(), memory);
            return;
          }
          const next = restoredConversation(
            conversation,
            memory.turnOpen,
            textsRef.current.interruptedByReload,
            textsRef.current.sealNote,
          );
          stateRef.current = next;
          setState(next);
          writeWindowMemory(sessionStore(), { conversationId: conversation.id, turnOpen: false });
          if (memory.turnOpen) {
            optionsRef.current.onInterruptedRestore?.();
            // Карточку оборванного хода сервер снимает, заметив обрыв, — часто
            // уже после того, как новая страница прочла список ожиданий, и кадр
            // итога проходит мимо ещё не подключённого потока. Без перечитки
            // снятая карточка стояла в окне как живая (живой прогон 26.09).
            const refresh = (): void =>
              void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentPending });
            refresh();
            setTimeout(refresh, 3_000);
          }
          return;
        } catch (error) {
          if (axios.isAxiosError(error) && error.response?.status === 404) {
            // Разговор удалили — помнить нечего.
            writeWindowMemory(sessionStore(), undefined);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [queryClient]);

  /** Разговор заново с сервера: там запечатанный ход и то, что сделала другая вкладка. */
  const reloadFromServer = async (id: string, note: string, settle: boolean): Promise<boolean> => {
    // После обрыва панель могла ещё подниматься, а ход — ещё не запечатан:
    // несколько попыток. Отставшей вкладке ждать нечего — одна.
    const conversation = await reloadSettledConversation(() => fetchPanelAgentConversation(id), {
      attempts: settle ? 5 : 1,
      wait: () => new Promise((resolve) => setTimeout(resolve, 2_000)),
    });
    if (!conversation) return false;
    // Пока ждали перечитку, человек мог начать новый разговор: чужой не кладём.
    const next = withReloadedConversation(
      stateRef.current,
      conversation,
      'error',
      note,
      textsRef.current.sealNote,
    );
    if (!next) return true;
    stateRef.current = next;
    setState(next);
    return true;
  };

  /** Запечатанный сервером ход, который окно сбросило; лента ушла дальше — не трогаем. */
  const catchUpSealedTurn = async (
    id: string,
    kind: 'notice' | 'error',
    note: string,
  ): Promise<void> => {
    const conversation = await reloadSettledConversation(() => fetchPanelAgentConversation(id), {
      attempts: 3,
      wait: () => new Promise((resolve) => setTimeout(resolve, 2_000)),
    });
    if (!conversation || pageHidingRef.current) return;
    const next = withSealedTurnCaughtUp(
      stateRef.current,
      conversation,
      kind,
      note,
      textsRef.current.sealNote,
    );
    if (!next) return;
    stateRef.current = next;
    setState(next);
  };

  const send = useCallback(
    async (
      text: string,
      context: PanelAgentPageContext,
      images: readonly AgentImage[] = [],
    ): Promise<void> => {
      const current = stateRef.current;
      if (current.running || !text.trim()) return;
      // Имена картинок — строкой в самой реплике: следующий ход знает, что
      // картинка была, хотя самой картинки уже не видит, а сверка истории с
      // файлом разговора идёт по тому же тексту, что записал сервер.
      const next = withUserMessage(
        current,
        withAgentImagesNote(
          text.trim(),
          images.map((image) => image.name),
        ),
      );
      stateRef.current = next;
      setState(next);

      const controller = new AbortController();
      controllerRef.current = controller;
      const outcome = await runPanelAgent(
        {
          messages: next.messages,
          ...(next.conversationId ? { conversationId: next.conversationId } : {}),
          context,
          ...(images.length > 0 ? { images: [...images] } : {}),
        },
        (event) => {
          // Ход идёт — помним об этом: F5 до его конца должен вернуть разговор
          // и сказать, что ход оборвала перезагрузка.
          if (event.kind === 'start') {
            writeWindowMemory(sessionStore(), {
              conversationId: event.conversationId,
              turnOpen: true,
            });
          }
          setState((prev) => applyRunEvent(prev, event));
        },
        controller.signal,
      );
      controllerRef.current = undefined;
      const conversationId = stateRef.current.conversationId ?? next.conversationId;
      if (pageHidingRef.current) return;
      if (conversationId) {
        writeWindowMemory(sessionStore(), { conversationId, turnOpen: false });
      }

      let reloadNote: string | undefined;
      if (!outcome.ok && conversationId && outcome.code === STREAM_LOST) {
        reloadNote = texts.streamLost;
      } else if (!outcome.ok && conversationId && outcome.code === CONVERSATION_STALE) {
        reloadNote = texts.staleReloaded(text.trim());
      }
      // Поток замолчал или вкладка отстала: правда — в файле разговора
      // (запечатанный ход, ответ другой вкладки). Перечитываем его, а не
      // додумываем ленту; не вышло — обычная строка об ошибке ниже.
      if (
        reloadNote &&
        conversationId &&
        (await reloadFromServer(conversationId, reloadNote, reloadNote === texts.streamLost))
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentConversations });
        void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentJournal });
        return;
      }

      // Разговор удалили в другой вкладке: его id больше не наш, следующее
      // сообщение начнёт новый разговор, а не вернёт удалённый.
      if (!outcome.ok && outcome.code === CONVERSATION_DELETED) {
        writeWindowMemory(sessionStore(), undefined);
        const fresh = withNotice(EMPTY_CONVERSATION, 'error', texts.deletedElsewhere(text.trim()));
        stateRef.current = fresh;
        setState(fresh);
        void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentConversations });
        return;
      }

      if (!outcome.ok) {
        const refusal = outcome.code ? texts.refusal(outcome.code) : undefined;
        const kind = outcome.aborted ? 'notice' : 'error';
        const note = outcome.aborted ? texts.stopped : texts.runFailed(refusal ?? outcome.message);
        setState((prev) => {
          // Кадр `error` уже написал причину в ленту — второй строкой её не повторяем.
          if (!prev.running) return prev;
          return withNotice(withTurnAborted(prev), kind, note);
        });
        // Агент успел что-то сказать или сделать — сервер запечатал ход в файле, а
        // окно пару сбросило: догоняем файл, иначе лента до конца сессии короче
        // того, что видит модель (ревью Z5-2).
        if (conversationId) void catchUpSealedTurn(conversationId, kind, note);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentConversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentJournal });
    },
    [queryClient, texts],
  );

  const stop = useCallback((): void => controllerRef.current?.abort(), []);

  const reset = useCallback((): void => {
    controllerRef.current?.abort();
    writeWindowMemory(sessionStore(), undefined);
    setState(EMPTY_CONVERSATION);
  }, []);

  const openConversation = useCallback(async (id: string): Promise<void> => {
    // Идущий ход не обрывается переключением: окно не даёт выбрать другой
    // разговор, пока ход идёт, а здесь — последний рубеж.
    if (stateRef.current.running) return;
    const conversation = await fetchPanelAgentConversation(id);
    writeWindowMemory(sessionStore(), { conversationId: conversation.id, turnOpen: false });
    setState(fromConversation(conversation, textsRef.current.sealNote));
  }, []);

  const note = useCallback((text: string, kind: 'notice' | 'error' = 'notice'): void => {
    setState((prev) => withNotice(prev, kind, text));
  }, []);

  /** Событие агента этого разговора (см. `isOwnConversationEvent`). */
  const isOwn = useCallback(
    (conversationId: string | undefined): boolean =>
      isOwnConversationEvent(conversationId, stateRef.current),
    [],
  );

  return { state, send, stop, reset, openConversation, note, isOwn };
}

export type PanelAgentSession = ReturnType<typeof usePanelAgentSession>;
