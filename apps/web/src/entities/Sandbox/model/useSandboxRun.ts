import { useCallback, useRef, useState } from 'react';
import { apiClient } from '@shared/api/client';

/**
 * Разговор внутри песочницы. Устроен так же, как чат, но обращается к своему
 * маршруту: там Claude Code запускается с временной конфигурацией и видит
 * только проверяемые настройки.
 */

export interface SandboxRunState {
  text: string;
  tools: string[];
  isRunning: boolean;
  error?: string;
  sessionId?: string;
  costUsd?: number;
}

const EMPTY: SandboxRunState = { text: '', tools: [], isRunning: false };

export function useSandboxRun() {
  const [state, setState] = useState<SandboxRunState>(EMPTY);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const run = useCallback(async (id: string, prompt: string): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...EMPTY, isRunning: true });

    try {
      const response = await fetch(`${apiClient.defaults.baseURL}/sandbox/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, prompt }),
        signal: controller.signal,
      });

      if (!response.body) throw new Error('Пустой ответ сервера');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
          const line = chunk.split('\n').find((part) => part.startsWith('data:'));
          if (!line) continue;

          const event = JSON.parse(line.slice(5)) as {
            kind: string;
            text?: string;
            name?: string;
            message?: string;
            sessionId?: string;
            costUsd?: number;
          };

          setState((current) => {
            if (event.kind === 'text')
              return { ...current, text: current.text + (event.text ?? '') };
            if (event.kind === 'tool') {
              return { ...current, tools: [...current.tools, event.name ?? ''] };
            }
            if (event.kind === 'error') return { ...current, error: event.message };
            if (event.kind === 'done') return { ...current, costUsd: event.costUsd };
            if (event.kind === 'session') return { ...current, sessionId: event.sessionId };
            return current;
          });
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      setState((current) => ({ ...current, isRunning: false }));
      abortRef.current = undefined;
    }
  }, []);

  const stop = useCallback((id: string): void => {
    void apiClient.post(`/sandbox/${encodeURIComponent(id)}/stop`);
    abortRef.current?.abort();
  }, []);

  const reset = useCallback((): void => setState(EMPTY), []);

  return { state, run, stop, reset };
}
