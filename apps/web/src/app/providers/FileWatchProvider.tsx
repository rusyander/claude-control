import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DOMAIN_KEYS } from '@shared/api/query-keys';

interface FileWatchProviderProps {
  children: ReactNode;
}

/**
 * Подписка на поток изменений с сервера. Конфиги правит не только это
 * приложение — их меняет пользователь в редакторе и сам Claude Code, поэтому
 * интерфейс обновляется по факту изменения файла, а не по таймеру.
 */
export function FileWatchProvider({ children }: FileWatchProviderProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { domains?: string[] };
      for (const domain of payload.domains ?? []) {
        for (const key of DOMAIN_KEYS[domain] ?? []) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }
    };

    // Браузер переподключает EventSource сам, поэтому ошибку достаточно
    // проглотить: иначе консоль засоряется при каждом перезапуске сервера.
    source.onerror = () => undefined;

    return () => source.close();
  }, [queryClient]);

  return children;
}
