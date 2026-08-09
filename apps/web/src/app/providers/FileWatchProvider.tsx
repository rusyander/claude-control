import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DOMAIN_KEYS } from '@shared/api/query-keys';
import type { FileWatchProviderProps } from './FileWatchProvider.types';

/**
 * Подписка на поток изменений с сервера. Конфиги правит не только это
 * приложение — их меняет пользователь в редакторе и сам Claude Code, поэтому
 * интерфейс обновляется по факту изменения файла, а не по таймеру.
 *
 * Соединение живёт часами и рвётся тихо: прокси разработки, спящая машина,
 * перезапуск сервера. Пока обрыв не замечен, панель показывает снимок — новый
 * разговор с телефона не появляется в списке, лента не дописывается, и человек
 * лечит это перезагрузкой страницы. Поэтому здесь не одна подписка, а её
 * поддержание: сервер шлёт пульс, браузер сам переподключается по ошибке, а
 * возвращение к вкладке подключается заново независимо от того, что думает
 * `readyState` — полуоткрытый сокет выглядит живым до первой попытки записи.
 */
export function FileWatchProvider({ children }: FileWatchProviderProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | undefined;
    /** Первое подключение за жизнь провайдера: данные на экране только что прочитаны. */
    let first = true;

    const onMessage = (event: MessageEvent<string>): void => {
      const payload = JSON.parse(event.data) as { domains?: string[]; path?: string };
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
        for (const key of DOMAIN_KEYS[domain] ?? []) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }
    };

    const connect = (): void => {
      source?.close();
      source = new EventSource('/api/events');
      source.onmessage = onMessage;
      // Браузер переподключает EventSource сам, поэтому ошибку достаточно
      // проглотить: иначе консоль засоряется при каждом перезапуске сервера.
      source.onerror = () => undefined;
      source.onopen = () => {
        // Это переподключение, а не первый вход: пока связи не было, файлы
        // менялись без нас — на экране может стоять что угодно.
        if (!first) void queryClient.invalidateQueries();
        first = false;
      };
    };

    // Вернулись к вкладке или в сеть — подключаемся заново, не веря `readyState`.
    const wake = (): void => {
      if (document.visibilityState === 'visible') connect();
    };

    connect();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);

    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      source?.close();
    };
  }, [queryClient]);

  return children;
}
