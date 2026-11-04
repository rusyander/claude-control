import type { PushDevice, TelegramSettings } from '@agentdeck/contracts';
import type { RelayNotice } from '@agentdeck/contracts/core/relay';
import { coreAskTelegramText, corePushMessages, type CorePushMessage } from './core-notice.ts';
import type { SentLog } from './telegram-answers/sent-log.ts';
import { deliverTelegram, type DeliveryResult } from './telegram-delivery.ts';

/**
 * Куда уходит вопрос ядра (этап 10, Q9): push на спаренные телефоны и сообщение Telegram. Подписка
 * та же, что у вопросов чата панели: push — «уведомления на телефон» включены, Telegram — включён,
 * у него есть чат и событие «вопрос» (или включены ответы из Telegram — им вопрос ядра тоже виден,
 * хоть ответить там и нельзя). Сообщение Telegram записано в журнал отправленного с `coreAsk`: по
 * нему reply владельца получает отказ, а не становится ответом (`telegram-answers/service.ts`).
 */
export interface CoreAskDeliveryDeps {
  telegram: () => Pick<TelegramSettings, 'enabled' | 'chatId' | 'events'>;
  token: () => string | undefined;
  /** Включены ли ответы из Telegram — тогда вопрос туда идёт и без события «вопрос». */
  answersCover: () => boolean;
  sentLog: SentLog;
  pushEnabled: () => boolean;
  devices: () => PushDevice[];
  machineId: () => string;
  /** Отправка push (сервис Expo); ошибки гасит сама. */
  push: (messages: CorePushMessage[]) => Promise<void>;
  onTelegramResult?: (result: DeliveryResult) => void;
  log: (line: string) => void;
}

export interface CoreAskDelivery {
  /**
   * Сообщить. `true` — хоть один канал принял (push ушёл на спаренные телефоны или Telegram
   * ответил ok); `false` — каналов нет или все упали: пересылка держит вопрос в ожидании.
   */
  deliver(notice: RelayNotice, question: string): Promise<boolean>;
  /** Настроен ли хоть один канал — без сети; нет — ждущие вопросы не трогаются. */
  ready(): boolean;
}

export function createCoreAskDelivery(deps: CoreAskDeliveryDeps): CoreAskDelivery {
  const pushReady = (): PushDevice[] => (deps.pushEnabled() ? deps.devices() : []);
  const telegramReady = (): { chatId: string; token: string } | null => {
    const settings = deps.telegram();
    if (!settings.enabled || !settings.chatId) return null;
    if (!settings.events.includes('question') && !deps.answersCover()) return null;
    const token = deps.token();
    return token ? { chatId: settings.chatId, token } : null;
  };

  return {
    ready: () => pushReady().length > 0 || telegramReady() !== null,
    async deliver(notice, question) {
      let told = false;
      const devices = pushReady();
      if (devices.length > 0) {
        // Ошибки сервиса Expo `push` гасит сам и не называет — ушедший запрос считается сообщением.
        told = await deps
          .push(corePushMessages(notice, devices, deps.machineId()))
          .then(() => true)
          .catch(() => false);
      }
      const telegram = telegramReady();
      if (!telegram) return told;
      const result = await deliverTelegram(
        telegram.token,
        telegram.chatId,
        coreAskTelegramText(notice, question),
      ).catch((error: unknown): DeliveryResult => ({ ok: false, error: String(error) }));
      deps.onTelegramResult?.(result);
      if (!result.ok) {
        deps.log(`core-relay: telegram not delivered: ${result.error}`);
        return told;
      }
      if (result.messageId !== undefined && notice.askId) {
        deps.sentLog.record({
          chatId: telegram.chatId,
          messageId: result.messageId,
          at: Date.now(),
          kind: 'bot',
          coreAsk: { taskId: notice.taskId, askId: notice.askId, deepLink: notice.deepLink },
        });
      }
      return true;
    },
  };
}
