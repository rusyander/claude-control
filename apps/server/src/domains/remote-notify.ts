import type { PushDevice } from '@claude-control/contracts';
import { basename } from 'node:path';
import type { RunNotice } from './chat/ChatRunRegistry.ts';

/**
 * Уведомления на телефон через сервис Expo.
 *
 * Почему через посредника, а не напрямую в APNs/FCM: тогда сервер панели должен
 * был бы держать ключи обеих платформ, а панель — стать местом, где эти ключи
 * лежат. Expo принимает один HTTPS-запрос с токеном устройства и разносит сам.
 *
 * НАРУЖУ УХОДИТ РОВНО ЗАГОЛОВОК: вид события и имя папки проекта. Ни промпта, ни
 * ответа агента, ни путей внутри проекта в теле нет — уведомление говорит «пора
 * посмотреть», а смотреть человек идёт в приложение, которое ходит уже в свой
 * сервер. Это осознанная граница, а не недоделка: содержимое разговора не имеет
 * причин покидать машину.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const SEND_TIMEOUT_MS = 10_000;

/** Что уведомителю нужно от состояния панели — ровно это, без самого стора. */
export interface NotifierDeps {
  /** Включены ли уведомления в настройках. */
  isEnabled: () => boolean;
  devices: () => PushDevice[];
  /** Сервис ответил, что токен мёртв (приложение снесли) — забыть устройство. */
  forget: (token: string) => void;
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId: string;
}

/** Заголовок и текст уведомления. Читает их человек — поэтому по-русски. */
function compose(notice: RunNotice): { title: string; body: string } {
  const project = notice.projectPath ? basename(notice.projectPath) : 'Домашний чат';
  switch (notice.kind) {
    case 'done':
      return { title: 'Работа закончена', body: project };
    case 'error':
      return { title: 'Прогон упал', body: project };
    case 'permission':
      return {
        title: 'Нужно разрешение',
        body: notice.toolName ? `${project}: ${notice.toolName}` : project,
      };
    case 'question':
      return { title: 'Агент задал вопрос', body: project };
  }
}

/**
 * Ответ сервиса Expo на один токен. Нас интересует единственный случай сверх
 * «ok»: `DeviceNotRegistered` — приложение удалили, и токен нужно забыть, иначе
 * список устройств будет копить мертвецов, а Expo — отвечать ошибкой вечно.
 */
interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export function createRunNotifier(deps: NotifierDeps): (notice: RunNotice) => void {
  return (notice) => {
    if (!deps.isEnabled()) return;
    const devices = deps.devices();
    if (devices.length === 0) return;

    const { title, body } = compose(notice);
    const messages: ExpoMessage[] = devices.map((device) => ({
      to: device.token,
      title,
      body,
      // По этим полям приложение открывает нужный разговор, а не просто себя.
      data: { kind: notice.kind, chatId: notice.chatId, projectPath: notice.projectPath ?? '' },
      sound: 'default',
      priority: 'high',
      // Канал заведён приложением при старте: без него Android показывает
      // уведомление беззвучно и без всплытия.
      channelId: 'runs',
    }));

    // Отправка ничего не ждёт и никого не задерживает: прогон уже завершился, и
    // единственное, чем сеть может помешать, — задержать ответ следующему
    // запросу. Ошибки гасим здесь же — уведомление не повод уронить сервер.
    void send(messages, deps.forget);
  };
}

async function send(messages: ExpoMessage[], forget: (token: string) => void): Promise<void> {
  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: ExpoTicket[] };
    const tickets = payload.data ?? [];
    tickets.forEach((ticket, index) => {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        const message = messages[index];
        if (message) forget(message.to);
      }
    });
  } catch {
    // Нет сети, лёг сервис, истёк таймаут — уведомление просто не дошло.
    // Состояние панели от этого не меняется, и падать тут не с чего.
  }
}
