import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DOMAIN_KEYS } from '@shared/api/query-keys';
import { publishPanelAgentEvent } from '@entities/PanelAgent';
import { refreshSettingsFromServer } from '@entities/AppConfig';
import { reportLinkError, reportLinkUp } from '@shared/lib/server-link';
import type { FileWatchProviderProps } from './FileWatchProvider.types';
import { shouldReconnectOnWake } from './shouldReconnectOnWake';

/** Через сколько пробовать снова поток, который браузер закрыл окончательно, мс. */
const RETRY_CLOSED_MS = 5_000;

export function FileWatchProvider({ children }: FileWatchProviderProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | undefined;
    /** Первое подключение за жизнь провайдера: данные на экране только что прочитаны. */
    let first = true;
    /** Когда вкладку свернули; пусто — она на виду. */
    let hiddenAt: number | undefined;
    /** Отложенная попытка подключиться заново после окончательного обрыва. */
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const onMessage = (event: MessageEvent<string>): void => {
      const raw: unknown = JSON.parse(event.data);
      // Кадры агента панели идут по этому же потоку: отдаём их окну агента и
      // дальше не разбираем — доменов изменений в них нет.
      if (publishPanelAgentEvent(raw)) return;
      const payload = raw as { domains?: string[]; path?: string };
      for (const domain of payload.domains ?? []) {
        // Транскрипты — единственный домен, где важно, ЧТО именно изменилось:
        // разговоров сотни, они пишутся постоянно (в том числе из терминала и
        // соседних окон), и общая инвалидация заставляла бы открытый чат
        // перечитываться из-за чужой переписки. Ленту трогаем только у того
        // разговора, чей файл дописали; список обновляем всегда — в нём
        // меняются превью и время, и там же появляется новый разговор.
        if (domain === 'chats') {
          void queryClient.invalidateQueries({ queryKey: ['chats'], exact: true });
          const sessionId = payload.path?.match(/([^\\/]+)\.jsonl$/)?.[1];
          if (sessionId) void queryClient.invalidateQueries({ queryKey: ['chats', sessionId] });
          continue;
        }
        // Настройки сменили снаружи (соседняя вкладка, телефон): мало перечитать —
        // язык, тема, провайдер должны примениться так же, как после своего PATCH.
        if (domain === 'settings') {
          void refreshSettingsFromServer(queryClient);
          continue;
        }
        for (const key of DOMAIN_KEYS[domain] ?? []) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }
    };

    const connect = (): void => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      source?.close();
      source = new EventSource('/api/events');
      source.onmessage = onMessage;
      // Браузер переподключает EventSource сам, поэтому ошибку достаточно
      // проглотить: иначе консоль засоряется при каждом перезапуске сервера.
      // Отмечаем её только для состояния связи (маскот говорит о пропаже) —
      // «пропала» объявляется, если поток не открылся за срок ожидания.
      // Ответ не 200 (сервер лежит, прокси Vite отдаёт 502) браузер считает
      // окончательным и больше не пробует: поток закрыт, и вернувшийся сервер
      // остался бы незамеченным до F5. Такой обрыв пробуем сами, раз в срок.
      source.onerror = () => {
        reportLinkError();
        if (source?.readyState === EventSource.CLOSED && retryTimer === undefined) {
          retryTimer = setTimeout(connect, RETRY_CLOSED_MS);
        }
      };
      source.onopen = () => {
        reportLinkUp();
        // Это переподключение, а не первый вход: пока связи не было, файлы
        // менялись без нас — на экране может стоять что угодно.
        if (!first) void queryClient.invalidateQueries();
        first = false;
      };
    };

    const wake = (): void => {
      if (document.visibilityState !== 'visible') {
        hiddenAt = Date.now();
        return;
      }
      const awayMs = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
      hiddenAt = undefined;
      if (shouldReconnectOnWake({ awayMs, closed: source?.readyState === EventSource.CLOSED })) {
        connect();
      }
    };

    // Сеть вернулась — это уже событие про связь, а не про внимание человека:
    // подключаемся заново независимо от того, сколько нас не было.
    const reconnect = (): void => connect();

    connect();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', reconnect);

    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', reconnect);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);

  return children;
}
