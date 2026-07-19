import { useCallback, useRef, useState } from 'react';
import { apiClient } from '@shared/api/client';

/**
 * Отправка сообщения и приём ответа по мере генерации.
 *
 * Обычный запрос тут не годится: ответ Claude идёт потоком, и его нужно
 * показывать сразу, а не после завершения. Поэтому берём fetch с чтением тела
 * по кускам — в отличие от EventSource он умеет POST и позволяет прервать
 * разговор, не дожидаясь конца.
 */

export interface StreamedTool {
  name: string;
  input: string;
}

export interface StreamState {
  /** Текст ответа, который набирается на глазах. */
  text: string;
  thinking: string;
  tools: StreamedTool[];
  isRunning: boolean;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  /** Момент сброса окна лимитов, unix-секунды. */
  limitResetsAt?: number;
}

const EMPTY: StreamState = { text: '', thinking: '', tools: [], isRunning: false };

export interface SendInput {
  chatId: string;
  prompt: string;
  sessionId?: string;
  name?: string;
  fork?: boolean;
  files?: { name: string; base64: string }[];
  /** Разрешить правку файлов, когда чат идёт в настоящем проекте. */
  allowEdits?: boolean;
  /** Каталог проекта для нового разговора, открытого из списка проектов. */
  projectPath?: string;
}

export function useChatStream(onFinished?: () => void) {
  const [state, setState] = useState<StreamState>(EMPTY);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const send = useCallback(
    async (input: SendInput): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Текст и инструменты прошлого ответа стираем, а идентификатор сессии
      // сохраняем: он и есть ниточка, по которой разговор продолжается. Раньше
      // он обнулялся вместе со всем остальным, и второе сообщение в новом чате
      // начинало разговор заново.
      setState((current) => ({
        ...EMPTY,
        sessionId: current.sessionId,
        limitResetsAt: current.limitResetsAt,
        isRunning: true,
      }));

      try {
        const response = await fetch(`${apiClient.defaults.baseURL}/chat/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`Сервер ответил ${response.status}`);
        if (!response.body) throw new Error('Пустой ответ сервера');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // События разделены пустой строкой; последний кусок может быть
          // неполным — оставляем его в буфере до следующей порции.
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';

          for (const chunk of chunks) {
            const line = chunk.split('\n').find((part) => part.startsWith('data:'));
            if (!line) continue;

            applyEvent(setState, JSON.parse(line.slice(5)) as ChatEvent);
          }
        }
      } catch (error) {
        // Прерывание кнопкой — не ошибка, а осознанное действие пользователя.
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        setState((current) => ({ ...current, isRunning: false }));
        abortRef.current = undefined;
        onFinished?.();
      }
    },
    [onFinished],
  );

  const stop = useCallback((chatId: string): void => {
    // Сервер убивает процесс, а клиент перестаёт читать поток.
    void apiClient.post(`/chat/${chatId}/stop`);
    abortRef.current?.abort();
  }, []);

  const reset = useCallback((): void => setState(EMPTY), []);

  return { state, send, stop, reset };
}

type ChatEvent =
  | { kind: 'session'; sessionId: string; model: string; tools: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; id: string }
  | { kind: 'limit'; resetsAt: number; type: string; status: string }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string };

function applyEvent(
  setState: React.Dispatch<React.SetStateAction<StreamState>>,
  event: ChatEvent,
): void {
  setState((current) => {
    switch (event.kind) {
      case 'session':
        return { ...current, sessionId: event.sessionId };
      case 'text':
        return { ...current, text: current.text + event.text };
      case 'thinking':
        return { ...current, thinking: current.thinking + event.text };
      case 'tool':
        return {
          ...current,
          tools: [...current.tools, { name: event.name, input: JSON.stringify(event.input) }],
        };
      case 'limit':
        return { ...current, limitResetsAt: event.resetsAt };
      case 'done':
        return { ...current, costUsd: event.costUsd, sessionId: event.sessionId };
      case 'error':
        return { ...current, error: event.message };
      default:
        return current;
    }
  });
}
