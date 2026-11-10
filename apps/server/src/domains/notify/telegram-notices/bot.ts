import {
  answerCallbackQuery,
  callHtml,
  type HtmlCallOptions,
} from '../telegram-answers/bot-api.ts';
import type { SentBotMessage } from '../telegram-answers/telegram-answers.types.ts';

/**
 * Отправка уведомлений ядра — тем же клиентом Bot API, что ответы (`callHtml`): очередь на чат,
 * 429 — ждём `retry_after` и повторяем по порядку (уведомление не теряется), разметка не
 * разобрана — простым текстом. Свои кнопки: кнопки ответов не знают ссылок, а MR — ссылка.
 */

export interface NoticeButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export type NoticeKeyboard = NoticeButton[][];

export interface NoticeBot {
  /** Номер отправленного сообщения; не ушло (после повторов 429) — `undefined`. */
  send(
    token: string,
    chatId: string,
    html: string,
    keyboard?: NoticeKeyboard,
    replyTo?: number,
  ): Promise<number | undefined>;
  /** Подсказка с принудительным ответом (force_reply) — «На доработку». */
  prompt(
    token: string,
    chatId: string,
    html: string,
    placeholder: string,
    replyTo: number,
  ): Promise<number | undefined>;
  edit(
    token: string,
    chatId: string,
    messageId: number,
    html: string,
    keyboard: NoticeKeyboard,
  ): Promise<boolean>;
  toast(token: string, pressId: string, text?: string): Promise<void>;
}

const replyTo = (messageId: number | undefined) =>
  messageId
    ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }
    : {};

export function createNoticeBot(options: HtmlCallOptions = {}): NoticeBot {
  return {
    async send(token, chatId, html, keyboard, to) {
      const sent = await callHtml<SentBotMessage>(
        token,
        'sendMessage',
        html,
        {
          chat_id: chatId,
          disable_web_page_preview: true,
          ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          ...replyTo(to),
        },
        options,
      );
      return sent.ok ? sent.result.message_id : undefined;
    },
    async prompt(token, chatId, html, placeholder, to) {
      const sent = await callHtml<SentBotMessage>(
        token,
        'sendMessage',
        html,
        {
          chat_id: chatId,
          reply_markup: { force_reply: true, input_field_placeholder: placeholder },
          ...replyTo(to),
        },
        options,
      );
      return sent.ok ? sent.result.message_id : undefined;
    },
    async edit(token, chatId, messageId, html, keyboard) {
      const done = await callHtml<unknown>(
        token,
        'editMessageText',
        html,
        {
          chat_id: chatId,
          message_id: messageId,
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: keyboard },
        },
        options,
      );
      // «message is not modified» — правка уже стоит: это успех, а не сбой.
      return done.ok || /not modified/i.test(done.description);
    },
    async toast(token, pressId, text) {
      await answerCallbackQuery(token, pressId, text);
    },
  };
}
