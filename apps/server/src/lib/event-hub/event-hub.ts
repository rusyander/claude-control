/**
 * Поток событий об изменениях файлов — подписчики `/api/events` и рассылка.
 *
 * Конфиги правит не только это приложение: их меняет пользователь руками и сам
 * Claude Code, — поэтому интерфейс должен узнавать об этом и обновляться, а не
 * показывать устаревшие данные. Наблюдатель за файлами зовёт `broadcast`,
 * маршрут потока подписывает каждое открытое соединение; объект живёт дольше
 * запроса, поэтому создаётся при сборке приложения и подаётся обоим.
 *
 * Агент панели шлёт по тому же потоку свои кадры (`emit`): второй поток значил
 * бы вторую переподписку в окне и второй пропуск кадров при обрыве. Кадр
 * `changed` остаётся прежним байт в байт — его разбирает веб и телефон.
 */
import type { PanelAgentEvent } from '@agentdeck/contracts/panel-agent';

export interface EventHub {
  /** Подписать отправителя кадров; возвращает отписку. */
  subscribe: (send: (payload: string) => void) => () => void;
  /** Разослать всем подписчикам «изменилось» с меткой времени. */
  broadcast: (domains: string[], path: string) => void;
  /** Разослать кадр агента панели: открыть страницу, карточка ждёт, решение принято. */
  emit: (event: PanelAgentEvent) => void;
  /** Сколько соединений открыто сейчас — для проверок. */
  size: () => number;
}

export function createEventHub(): EventHub {
  const subscribers = new Set<(payload: string) => void>();
  const deliverAll = (payload: string): void => {
    for (const deliver of subscribers) deliver(payload);
  };

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
      deliverAll(payload);
    },
    emit: (event) => {
      deliverAll(JSON.stringify({ ...event, at: new Date().toISOString() }));
    },
    size: () => subscribers.size,
  };
}
