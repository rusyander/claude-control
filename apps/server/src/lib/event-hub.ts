/**
 * Поток событий об изменениях файлов — подписчики `/api/events` и рассылка.
 *
 * Конфиги правит не только это приложение: их меняет пользователь руками и сам
 * Claude Code, — поэтому интерфейс должен узнавать об этом и обновляться, а не
 * показывать устаревшие данные. Наблюдатель за файлами зовёт `broadcast`,
 * маршрут потока подписывает каждое открытое соединение; объект живёт дольше
 * запроса, поэтому создаётся при сборке приложения и подаётся обоим.
 */
export interface EventHub {
  /** Подписать отправителя кадров; возвращает отписку. */
  subscribe: (send: (payload: string) => void) => () => void;
  /** Разослать всем подписчикам «изменилось» с меткой времени. */
  broadcast: (domains: string[], path: string) => void;
  /** Сколько соединений открыто сейчас — для проверок. */
  size: () => number;
}

export function createEventHub(): EventHub {
  const subscribers = new Set<(payload: string) => void>();

  return {
    subscribe: (send) => {
      subscribers.add(send);
      return () => {
        subscribers.delete(send);
      };
    },
    broadcast: (domains, path) => {
      const payload = JSON.stringify({
        type: 'changed',
        domains,
        path,
        at: new Date().toISOString(),
      });
      for (const send of subscribers) send(payload);
    },
    size: () => subscribers.size,
  };
}
