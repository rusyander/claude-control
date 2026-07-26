import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@shared/api/client';
import { createRunAbort, type RunAbort } from './sandboxAbort';
import { sandboxErrorText } from './sandboxError';
import { parseSandboxFrame } from './sandboxFrame';

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
  const { t } = useTranslation();
  const [state, setState] = useState<SandboxRunState>(EMPTY);
  const abortRef = useRef<RunAbort | undefined>(undefined);
  abortRef.current ??= createRunAbort();
  const aborter = abortRef.current;

  // Уход со страницы (переключение вкладки, закрытие окна) обязан прервать
  // прогон: пока соединение открыто, сервер не видит `close` и не убивает
  // временный Claude — тот доработал бы прогон до конца уже никому не нужным.
  useEffect(() => () => aborter.abort(), [aborter]);

  const run = useCallback(
    async (id: string, prompt: string): Promise<void> => {
      const controller = aborter.start();

      setState({ ...EMPTY, isRunning: true });

      try {
        const response = await fetch(`${apiClient.defaults.baseURL}/sandbox/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, prompt }),
          signal: controller.signal,
        });

        // Отказ приходит обычным JSON, а не потоком: без этой проверки чтение
        // не находило ни одного события и экран оставался пустым — молчание
        // Claude на вид, ошибка сервера на деле.
        if (!response.ok) {
          // 410 — песочницу убрало подметание по простою. Причина известна
          // заранее, поэтому текст берём переведённый: разговор продолжать не в
          // чем, окно надо открыть заново.
          if (response.status === 410) throw new Error(t('sandbox.expired'));

          const detail = sandboxErrorText(await response.text());
          throw new Error(detail ?? t('sandbox.runFailed', { status: response.status }));
        }

        if (!response.body) throw new Error(t('sandbox.emptyResponse'));

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
            // Кадр без `data:` или с неразборным JSON пропускаем: один битый
            // кадр не должен обрывать чтение и подменять ответ агента
            // синтаксической ошибкой.
            const event = parseSandboxFrame(chunk);
            if (!event) continue;

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
        // Именно свой контроллер: прерванный прогон доходит сюда уже после
        // старта следующего и обнулил бы учёт живого.
        aborter.finish(controller);
      }
    },
    [aborter, t],
  );

  const stop = useCallback(
    (id: string): void => {
      void apiClient.post(`/sandbox/${encodeURIComponent(id)}/stop`);
      aborter.abort();
    },
    [aborter],
  );

  const reset = useCallback((): void => setState(EMPTY), []);

  return { state, run, stop, reset };
}
