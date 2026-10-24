import type { InboxLaunch, InboxQuestion } from '@agentdeck/contracts/chat-inbox';
import type {
  TelegramAnswersSettings,
  TelegramAnswersStatus,
} from '@agentdeck/contracts/telegram-answers';

/** Итог вызова Bot API: значение, а не исключение — опросу нужен код. */
export type BotCall<T> =
  | { ok: true; status: number; result: T }
  | { ok: false; status: number; description: string; aborted?: boolean };

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];
export type ReplyMarkup =
  | { inline_keyboard: InlineKeyboard }
  | { force_reply: true; input_field_placeholder?: string; selective?: boolean };

export interface BotUser {
  id: number;
  is_bot?: boolean;
}
export interface BotChat {
  id: number;
  type?: string;
}
export interface SentBotMessage {
  message_id: number;
  chat: BotChat;
}
export interface BotMessage extends SentBotMessage {
  from?: BotUser;
  text?: string;
  reply_to_message?: { message_id: number };
}
export interface BotUpdate {
  update_id: number;
  message?: BotMessage;
  callback_query?: {
    id: string;
    from: BotUser;
    data?: string;
    message?: { message_id: number; chat: BotChat };
  };
}

/** Чей вопрос — строкой источника в сообщении. */
export interface AskSourceInfo {
  project: string;
  chatTitle: string;
  cli: string;
  app: 'agentdeck' | 'outside';
  background?: boolean;
  group?: { index: number; title?: string; stage?: string; parentTitle?: string };
}

/**
 * Куда уходит ответ — ровно тот маршрут, которым ответила бы панель или телефон.
 * Второго пути к брокеру нет: Telegram зовёт те же маршруты изнутри сервера.
 */
export type AskTarget =
  | { kind: 'permission'; runKey: string; toolUseId: string }
  | { kind: 'branchGate'; runKey: string; toolUseId: string }
  | { kind: 'relayPermission'; toolUseId: string }
  | {
      kind: 'question';
      chatId: string;
      sessionId?: string;
      projectPath: string;
      runKey?: string;
    }
  | { kind: 'relayQuestion'; toolUseId: string }
  | { kind: 'foreign'; chatId: string; askId: string }
  | { kind: 'deferred'; id: string };

/** Что сейчас ждёт человека — одно ожидание, собранное из всех источников. */
export interface PendingAskItem {
  /** Устойчивое имя ожидания: по нему вопрос не уходит дважды. */
  key: string;
  target: AskTarget;
  /** Что открыть в панели (`/chat?id=`). */
  openId: string;
  source: AskSourceInfo;
  askedAt: string;
  /** Группа или отложенный D-n: не ждать `afterMinutes`, уходит сразу. */
  immediate: boolean;
  toolName?: string;
  /** Что именно спрошено — уже под маской секретов. */
  summary?: string;
  launch?: InboxLaunch;
  questions?: InboxQuestion[];
  /** Причина D-n — почему решает человек. */
  reason?: string;
}

/** Ожидание в отправленном сообщении. */
export interface SentItem {
  key: string;
  target: AskTarget;
  /** Что открыть в панели (`/chat?id=`); пусто — раздел чата без разговора. */
  openId: string;
  /** Текст ожидания, как его увидел человек при отправке. */
  text: string;
  questions?: InboxQuestion[];
  state: 'open' | 'done';
  /** Строка итога: «✅ Разрешено · 19:52». */
  outcome?: string;
  /** Номер текущего вопроса вызова `AskUserQuestion`. */
  step?: number;
  /** Выбранное по каждому вопросу. */
  picks?: string[][];
  /** Сообщение «напишите ответ», ответ на которое — свой ответ на вопрос `step`. */
  customPrompt?: number;
  /** С какого момента ожидания нет в сводке (мс); пропажа подтверждается не сразу. */
  missingSince?: number;
}

/**
 * Действие кнопки. Номер действия — часть `callback_data`, само действие живёт
 * здесь: нажатие несёт только номер и подпись, остальное сервер знает сам.
 */
export interface ButtonAction {
  item: number;
  act: 'allow' | 'deny' | 'here' | 'stop' | 'pick' | 'toggle' | 'done' | 'custom' | 'expand';
  /** Номер варианта (`pick`, `toggle`) и вопроса, к которому он относится. */
  option?: number;
  step?: number;
}

export interface SentMessage {
  /** Короткий номер сообщения — часть `callback_data`. */
  sid: string;
  chatId: string;
  messageId: number;
  /** Случайная соль подписи кнопок этого сообщения. */
  nonce: string;
  sentAt: string;
  items: SentItem[];
  actions: Record<string, ButtonAction>;
  nextAction: number;
  closedAt?: string;
}

export interface AnswersFile {
  version: 1;
  /** Ключ подписи кнопок (HMAC) — живёт только на этой машине. */
  secret: string;
  /** Следующее обновление Bot API: переживает перезапуск, старое не приходит дважды. */
  offset: number;
  nextSid: number;
  settings: TelegramAnswersSettings;
  messages: SentMessage[];
  /** Уже отправленные ожидания: ключ → когда. Повторно не уходят. */
  sent: Record<string, string>;
  lastSentAt?: number;
}

/** Почему ожидание пропало из сводки, пока висело в Telegram. */
export type Vanished = { kind: 'inPanel' } | { kind: 'stale' } | { kind: 'deferred'; id: string };

export interface AnswersStatusHolder {
  status: TelegramAnswersStatus;
  settings?: TelegramAnswersSettings;
}

/** Исход применения ответа маршрутом панели. */
export type ApplyOutcome =
  | { ok: true }
  | { ok: false; gone: true; detail?: string }
  | { ok: false; gone?: false; detail: string };
