import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PanelAgentPageContext } from '@agentdeck/contracts/panel-agent';
import { fetchPanelAgentConversation, runPanelAgent } from '@entities/PanelAgent';
import { queryKeys } from '@shared/api/query-keys';
import {
  EMPTY_CONVERSATION,
  applyRunEvent,
  fromConversation,
  withNotice,
  withTurnAborted,
  withUserMessage,
  type ConversationState,
} from './conversation';

export interface PanelAgentSessionTexts {
  stopped: string;
  runFailed: (message: string) => string;
  /** Текст отказа по коду сервера; неизвестный код — пусто, тогда слова сервера. */
  refusal: (code: string) => string | undefined;
}

/**
 * Разговор с агентом панели. Живёт в каркасе, а не в самом окне: окно
 * закрывают, чтобы посмотреть на открытую агентом страницу, и закрытие не
 * должно обрывать ход — обрыв запроса останавливает агента на сервере.
 */
export function usePanelAgentSession(texts: PanelAgentSessionTexts) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConversationState>(EMPTY_CONVERSATION);
  const stateRef = useRef(state);
  stateRef.current = state;
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const send = useCallback(
    async (text: string, context: PanelAgentPageContext): Promise<void> => {
      const current = stateRef.current;
      if (current.running || !text.trim()) return;
      const next = withUserMessage(current, text.trim());
      stateRef.current = next;
      setState(next);

      const controller = new AbortController();
      controllerRef.current = controller;
      const outcome = await runPanelAgent(
        {
          messages: next.messages,
          ...(next.conversationId ? { conversationId: next.conversationId } : {}),
          context,
        },
        (event) => setState((prev) => applyRunEvent(prev, event)),
        controller.signal,
      );
      controllerRef.current = undefined;

      if (!outcome.ok) {
        setState((prev) => {
          // Кадр `error` уже написал причину в ленту — второй строкой её не повторяем.
          if (!prev.running) return prev;
          const refusal = outcome.code ? texts.refusal(outcome.code) : undefined;
          const note = outcome.aborted
            ? texts.stopped
            : texts.runFailed(refusal ?? outcome.message);
          return withNotice(withTurnAborted(prev), outcome.aborted ? 'notice' : 'error', note);
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentConversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentJournal });
    },
    [queryClient, texts],
  );

  const stop = useCallback((): void => controllerRef.current?.abort(), []);

  const reset = useCallback((): void => {
    controllerRef.current?.abort();
    setState(EMPTY_CONVERSATION);
  }, []);

  const openConversation = useCallback(async (id: string): Promise<void> => {
    controllerRef.current?.abort();
    const conversation = await fetchPanelAgentConversation(id);
    setState(fromConversation(conversation));
  }, []);

  const note = useCallback((text: string, kind: 'notice' | 'error' = 'notice'): void => {
    setState((prev) => withNotice(prev, kind, text));
  }, []);

  return { state, send, stop, reset, openConversation, note };
}

export type PanelAgentSession = ReturnType<typeof usePanelAgentSession>;
