import { useCallback, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import {
  EMPTY_CONVERSATION,
  applyRunEvent,
  reloadSettledConversation,
  sealNoteFrom,
  withNotice,
  withReloadedConversation,
  withSealedTurnCaughtUp,
  withTurnAborted,
  withUserMessage,
  type ConversationState,
  type SealNote,
} from '@agentdeck/contracts/panel-agent-feed';
import { PANEL_AGENT_KEYS, fetchPanelAgentConversation } from '../../entities/panel-agent/api';
import { phoneContext } from '../../entities/panel-agent/model';
import {
  STREAM_LOST,
  runResumablePanelAgent,
  stopPanelAgent,
  type RunEventSink,
} from '../../entities/panel-agent/run';
import { useT } from '../../shared/config/i18n';
import { openConversation } from './openConversation';

/** Приложение снова на экране: в фоне сеть закрыта, возвращаться к ходу оттуда бесполезно. */
function foreground(): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      subscription.remove();
      resolve();
    });
  });
}

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
  // Пометка запечатанного ответа языком телефона: в файле хвост английский, для модели.
  const sealNote: SealNote = useMemo(
    () =>
      sealNoteFrom({
        actions: t.agent.sealed.actions,
        failed: t.agent.sealed.failed,
        notFinished: t.agent.sealed.notFinished,
        reason: t.agent.sealed.reason,
      }),
    [t],
  );
  const sealNoteRef = useRef(sealNote);
  sealNoteRef.current = sealNote;

  const send = useCallback(
    async (text: string): Promise<void> => {
      const current = stateRef.current;
      if (current.running || !text.trim()) return;
      const next = withUserMessage(current, text.trim());
      stateRef.current = next;
      setState(next);

      const controller = new AbortController();
      controllerRef.current = controller;
      // Id нового разговора приходит кадром `start` — он нужен, чтобы перечитать
      // разговор после обрыва связи.
      let conversationId = next.conversationId;
      const sink: RunEventSink = (event) => {
        if (event.kind === 'start') conversationId = event.conversationId;
        setState((prev) => applyRunEvent(prev, event));
      };
      // Кадры шли с номерами — сервер держит ход после обрыва (F-101, D3), и
      // телефон догоняет его сам. Сервер без номеров ход уже снял — ниже прежний
      // путь, перечитка разговора из файла.
      const outcome = await runResumablePanelAgent(
        {
          messages: next.messages,
          ...(next.conversationId ? { conversationId: next.conversationId } : {}),
          context: phoneContext(projectPath),
        },
        sink,
        controller.signal,
        { ready: foreground },
      );
      controllerRef.current = undefined;

      // Связь пропала посреди хода (панель перезапустилась, поток замолчал):
      // правда — в файле разговора, где сервер запечатал ход. Перечитываем его,
      // а не додумываем ленту; не вышло — строка об обрыве ниже. Панель могла ещё
      // подниматься, а ход — ещё не запечатан: несколько попыток, как у окна панели.
      if (!outcome.ok && outcome.code === STREAM_LOST && conversationId) {
        const id = conversationId;
        // Из фона файл не прочитать — сеть закрыта; ждём возвращения на экран.
        await foreground();
        const fresh = await reloadSettledConversation(() => fetchPanelAgentConversation(id), {
          attempts: 5,
          wait: () => new Promise((resolve) => setTimeout(resolve, 2_000)),
        });
        if (fresh) {
          // Перечитка ждёт до ~10 с: экран мог уйти в новый разговор — чужой не кладём.
          const reloaded = withReloadedConversation(
            stateRef.current,
            fresh,
            'error',
            t.agent.streamLost,
            sealNote,
          );
          if (reloaded) setState(reloaded);
          void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.conversations });
          void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.journal });
          return;
        }
      }

      // Разговор продолжили в другом окне: лента телефона отстала от файла, и
      // каждая следующая попытка упиралась бы в тот же отказ — перечитываем.
      if (!outcome.ok && outcome.code === 'conversation_stale' && next.conversationId) {
        const fresh = await fetchPanelAgentConversation(next.conversationId).catch(() => undefined);
        if (fresh) {
          const reloaded = withReloadedConversation(
            stateRef.current,
            fresh,
            'error',
            t.agent.refusal.conversation_stale!,
            sealNote,
          );
          if (reloaded) setState(reloaded);
          void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.conversations });
          return;
        }
      }
      // Разговор удалили в другом окне: писать в него — вернуть удалённое.
      // Следующее сообщение начнёт новый разговор.
      if (!outcome.ok && outcome.code === 'conversation_deleted') {
        setState(withNotice(EMPTY_CONVERSATION, 'error', t.agent.refusal.conversation_deleted!));
        void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.conversations });
        return;
      }

      if (!outcome.ok) {
        // Текст с кодом сервера называет провайдера и причину — точнее строки по коду.
        const refusal =
          outcome.code && !outcome.localized ? t.agent.refusal[outcome.code] : undefined;
        const detail =
          refusal ?? (outcome.message || (outcome.status ? t.run.answered(outcome.status) : ''));
        const kind: 'notice' | 'error' = outcome.aborted ? 'notice' : 'error';
        const failed = outcome.code === STREAM_LOST ? t.agent.cut : t.agent.runFailed(detail);
        const note = outcome.aborted ? t.agent.stopped : failed;
        setState((prev) => {
          // Кадр `error` уже написал причину в ленту — второй строкой не повторяем.
          if (!prev.running) return prev;
          return withNotice(withTurnAborted(prev), kind, note);
        });
        // Агент успел что-то сказать или сделать — сервер запечатал ход в файле, а
        // лента пару сбросила: догоняем файл, как окно панели (ревью Z5-2).
        if (conversationId) {
          const id = conversationId;
          void reloadSettledConversation(() => fetchPanelAgentConversation(id), {
            attempts: 3,
            wait: () => new Promise((resolve) => setTimeout(resolve, 2_000)),
          }).then((fresh) => {
            if (fresh) {
              setState((prev) => withSealedTurnCaughtUp(prev, fresh, kind, note, sealNote) ?? prev);
            }
          });
        }
      }
      void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.conversations });
      void queryClient.invalidateQueries({ queryKey: PANEL_AGENT_KEYS.journal });
    },
    [projectPath, queryClient, t, sealNote],
  );

  // Ход с возвратом обрыв запроса не снимает — «Стоп» говорим серверу словами.
  // Сервер без возврата маршрута не знает, ему хватает оборванного запроса.
  const stopTurn = useCallback((): void => {
    const current = stateRef.current;
    controllerRef.current?.abort();
    if (current.running && current.conversationId) void stopPanelAgent(current.conversationId);
  }, []);

  const stop = stopTurn;

  const reset = useCallback((): void => {
    stopTurn();
    setState(EMPTY_CONVERSATION);
  }, [stopTurn]);

  const openFailed = t.agent.openFailed;
  const open = useCallback(
    async (id: string): Promise<void> => {
      stopTurn();
      setState(
        await openConversation({
          load: () => fetchPanelAgentConversation(id),
          sealNote: sealNoteRef.current,
          failed: openFailed,
        }),
      );
    },
    [openFailed, stopTurn],
  );

  return { state, send, stop, reset, open };
}
