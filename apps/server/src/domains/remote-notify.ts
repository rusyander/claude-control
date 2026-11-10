import type { PushDevice } from '@agentdeck/contracts';
import { isRemotePushKind } from '@agentdeck/contracts/push-kinds';
import { basename } from 'node:path';
import type { RunNotice } from './notify/run-notice.types.ts';

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
 *
 * ЗВОНИТ ТОЛЬКО ТО, ЧТО ЖДЁТ ЧЕЛОВЕКА (этап 12, P175): разрешение и вопрос агента
 * (`REMOTE_PUSH_KINDS`), вопрос ядра — если он блокирует (`askWaits`, пересылка). «Готово» и
 * «упало» в push не уходят: их видно на доске и в чате, а телефон, звонящий о каждом конце
 * хода, приучает не смотреть на него и тогда, когда работа встала.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/**
 * Адрес сервиса Expo для проверок: поддельный сервис на loopback (проверка пересылки на стенде).
 * Только loopback — переменная не может увести заголовки уведомлений на чужой адрес.
 */
export const EXPO_PUSH_URL_ENV = 'AGENTDECK_EXPO_PUSH_URL';
const SEND_TIMEOUT_MS = 10_000;
/** Сколько вопросов помнит журнал push: старше — давно отвечены. */
const PUSH_ONCE_MAX = 2000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function expoPushUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[EXPO_PUSH_URL_ENV]?.trim();
  if (!override) return EXPO_PUSH_URL;
  try {
    const url = new URL(override);
    if (LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  } catch {
    // Кривой адрес — настоящий сервис, как без переменной.
  }
  return EXPO_PUSH_URL;
}

/**
 * Один push на вопрос (`askId`) на оба отправителя (этап 12, P175). Вопрос права задачи ядра в
 * чате приходит дважды: карточкой прогона чата (уведомитель) и строкой `human.asked` (пересылка).
 * Кто первый занял номер — тот и звонит, второй молчит. Ключ — номер вопроса, не чат: два вопроса
 * одного чата — два звонка.
 */
export interface PushOnce {
  /** `true` — номер был свободен и теперь занят (звонить); `false` — о нём уже звонили. */
  claim(askId: string): boolean;
}

export function createPushOnce(max: number = PUSH_ONCE_MAX): PushOnce {
  const seen = new Set<string>();
  return {
    claim(askId) {
      if (seen.has(askId)) return false;
      seen.add(askId);
      // Set помнит порядок вставки: старейший номер уходит первым.
      const oldest = seen.values().next().value;
      if (seen.size > max && oldest !== undefined) seen.delete(oldest);
      return true;
    },
  };
}

/** Что уведомителю нужно от состояния панели — ровно это, без самого стора. */
export interface NotifierDeps {
  /** Включены ли уведомления в настройках. */
  isEnabled: () => boolean;
  devices: () => PushDevice[];
  /** Сервис ответил, что токен мёртв (приложение снесли) — забыть устройство. */
  forget: (token: string) => void;
  /**
   * Случайный номер машины (`lib/machine-identity`). Телефон бывает спарен с
   * несколькими панелями — по номеру нажатие на уведомление открывает нужную.
   * Имя машины наружу не уходит: в Expo едут только вид события, папка и номер.
   */
  machineId?: () => string;
  /** Журнал push по вопросам — общий с пересылкой вопросов ядра (`notify/core-ask-delivery.ts`). */
  once: PushOnce;
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

type WaitingNotice = RunNotice & { kind: 'permission' | 'question' };

/** Заголовок и текст уведомления. Читает их человек — поэтому по-русски. */
function compose(notice: WaitingNotice): { title: string; body: string } {
  const project = notice.projectPath ? basename(notice.projectPath) : 'Домашний чат';
  switch (notice.kind) {
    case 'permission':
      return {
        title: 'Нужно разрешение',
        body: notice.toolName ? `${project}: ${notice.toolName}` : project,
      };
    case 'question':
      return { title: 'Агент задал вопрос', body: project };
  }
}

/** Проверочное уведомление из настроек: звонит всегда и никуда не ведёт по нажатию. */
const TEST_PUSH = {
  title: 'Проверочное уведомление',
  body: 'Так придёт то, что ждёт вашего ответа',
};

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
    // Проверочное звонит всегда: оно и проверяет, что звонок дойдёт.
    if (!notice.test && !isRemotePushKind(notice.kind)) return;
    if (!deps.isEnabled()) return;
    const devices = deps.devices();
    if (devices.length === 0) return;
    if (notice.askId !== undefined && !deps.once.claim(notice.askId)) return;

    const machineId = deps.machineId?.();
    const { title, body } = notice.test ? TEST_PUSH : compose(notice as WaitingNotice);
    // По этим полям приложение открывает нужный разговор, а не просто себя.
    const data: Record<string, unknown> = notice.test
      ? { kind: 'test', ...(machineId ? { machineId } : {}) }
      : {
          kind: notice.kind,
          chatId: notice.chatId,
          projectPath: notice.projectPath ?? '',
          ...(machineId ? { machineId } : {}),
        };
    const messages: ExpoMessage[] = devices.map((device) => ({
      to: device.token,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      // Канал заведён приложением при старте: без него Android показывает
      // уведомление беззвучно и без всплытия.
      channelId: 'runs',
    }));

    // Отправка ничего не ждёт и никого не задерживает: единственное, чем сеть
    // может помешать, — задержать ответ следующему запросу. Ошибки гасим здесь
    // же — уведомление не повод уронить сервер.
    void sendExpoPush(messages, deps.forget);
  };
}

/** Отправка в Expo; её же берёт пересылка вопросов ядра (`domains/notify/core-ask-delivery.ts`). */
export async function sendExpoPush(
  messages: ExpoMessage[],
  forget: (token: string) => void,
): Promise<void> {
  try {
    const response = await fetch(expoPushUrl(), {
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
