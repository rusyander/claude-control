import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toErrorMessage } from '@shared/api/client';
import {
  openProviderChatStream,
  providerChatKeys,
  readProviderChatStatus,
  sendProviderChatMessage,
  stopProviderChat,
} from '../api/ProviderChatApi';

/**
 * Идущий ответ открытого разговора: текст, который уже напечатан, и признак
 * работы.
 *
 * Ответ принадлежит серверу, а не вкладке. Поэтому здесь всего два действия —
 * подключиться к потоку и сверить состояние: закрыли вкладку, ушли на другую
 * страницу, нажали F5 — ответ всё это время шёл, и по возвращении показывается
 * то, что успело накопиться, а не пустой экран.
 */
export interface ProviderChatRunState {
  /** Текст, напечатанный к этому моменту (пустой — ответа сейчас нет). */
  partial: string;
  isRunning: boolean;
  /** Текст ошибки последнего ответа: показывается один раз, до нового вопроса. */
  error?: string;
  send: (text: string, attachments?: string[]) => Promise<void>;
  stop: () => Promise<void>;
}

export function useProviderChatRun(chatId: string | undefined): ProviderChatRunState {
  const queryClient = useQueryClient();
  const [partial, setPartial] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  /** Ответ кончился: перечитываем переписку и сверяемся с сервером. */
  const settle = useCallback(
    async (id: string) => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });

      try {
        const status = await readProviderChatStatus(id);
        setIsRunning(status.isRunning);
        setPartial(status.isRunning ? status.partial : '');
      } catch {
        setIsRunning(false);
        setPartial('');
      }
    },
    [queryClient],
  );

  const attach = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await openProviderChatStream(
          id,
          (event) => {
            if (event.type === 'delta') setPartial((prev) => prev + (event.text ?? ''));
            else if (event.type === 'error') setError(event.error);
          },
          controller.signal,
        );
      } catch {
        // Обрыв потока — не потеря ответа: он пишется на сервере, и сверка ниже
        // покажет, чем всё кончилось.
      }

      if (controller.signal.aborted) return;
      await settle(id);
    },
    [settle],
  );

  // Открыли разговор — узнаём, не идёт ли по нему ответ прямо сейчас.
  useEffect(() => {
    setPartial('');
    setIsRunning(false);
    setError(undefined);
    if (!chatId) return;

    let cancelled = false;
    void (async () => {
      try {
        const status = await readProviderChatStatus(chatId);
        if (cancelled || !status.isRunning) return;
        setPartial(status.partial);
        setIsRunning(true);
        void attach(chatId);
      } catch {
        // Разговора нет или сервер недоступен — показывать нечего.
      }
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [chatId, attach]);

  const send = useCallback(
    async (text: string, attachments?: string[]) => {
      if (!chatId) return;

      setError(undefined);
      setPartial('');
      setIsRunning(true);
      try {
        await sendProviderChatMessage(chatId, {
          text,
          ...(attachments?.length ? { attachments } : {}),
        });
      } catch (cause) {
        setIsRunning(false);
        setError(toErrorMessage(cause));
        return;
      }

      void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(chatId) });
      await attach(chatId);
    },
    [chatId, attach, queryClient],
  );

  const stop = useCallback(async () => {
    if (!chatId) return;
    try {
      await stopProviderChat(chatId);
    } catch {
      // Гасить нечего либо сервер уже закрыл прогон — состояние сверит поток.
    }
  }, [chatId]);

  return { partial, isRunning, ...(error ? { error } : {}), send, stop };
}
