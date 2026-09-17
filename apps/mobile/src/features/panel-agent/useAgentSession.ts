import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  EMPTY_CONVERSATION,
  applyRunEvent,
  fromConversation,
  withNotice,
  withTurnAborted,
  withUserMessage,
  type ConversationState,
} from '@agentdeck/contracts/panel-agent-feed';
import { PANEL_AGENT_KEYS, fetchPanelAgentConversation } from '../../entities/panel-agent/api';
import { phoneContext } from '../../entities/panel-agent/model';
import { runPanelAgent } from '../../entities/panel-agent/run';
import { useT } from '../../shared/config/i18n';

/**
 * Разговор с агентом панели на телефоне. Лента — та же функция из контрактов,
 * что у окна панели: один разговор, открытый в двух местах, выглядит одинаково.
 */
export function useAgentSession(projectPath?: string) {
  const t = useT();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConversationState>(EMPTY_CONVERSATION);
  const stateRef = useRef(state);
  stateRef.current = state;
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const send = useCallback(
    async (text: string): Promise<void> => {
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
          context: phoneContext(projectPath),
        },
        (event) => setState((prev) => applyRunEvent(prev, event)),
        controller.signal,
      );
      controllerRef.current = undefined;

      if (!outcome.ok) {
        setState((prev) => {
          // Кадр `error` уже написал причину в ленту — второй строкой не повторяем.
          if (!prev.running) return prev;
          if (outcome.aborted) return withNotice(withTurnAborted(prev), 'notice', t.agent.stopped);
          if (outcome.code === 'cut')
            return withNotice(withTurnAborted(prev), 'error', t.agent.cut);
          const refusal = outcome.code ? t.agent.refusal[outcome.code] : undefined;
          const detail =
            refusal ?? (outcome.message || (outcome.status ? t.run.answered(outcome.status) : ''));
          return withNotice(withTurnAborted(prev), 'error', t.agent.runFailed(detail));
        });
      }
      void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.conversations });
      void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.journal });
    },
    [projectPath, queryClient, t],
  );

  const stop = useCallback((): void => controllerRef.current?.abort(), []);

  const reset = useCallback((): void => {
    controllerRef.current?.abort();
    setState(EMPTY_CONVERSATION);
  }, []);

  const open = useCallback(async (id: string): Promise<void> => {
    controllerRef.current?.abort();
    setState(fromConversation(await fetchPanelAgentConversation(id)));
  }, []);

  return { state, send, stop, reset, open };
}
