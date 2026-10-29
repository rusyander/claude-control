import type { InboxClient, InboxLaunch, InboxQuestion } from '@agentdeck/contracts/chat-inbox';
import type { TelegramAnswersSettings } from '@agentdeck/contracts/telegram-answers';

/** Итог вызова Bot API: значение, а не исключение — опросу нужен код. */
export type BotCall<T> =
  | { ok: true; status: number; result: T }
  | {
      ok: false;
      status: number;
      description: string;
      aborted?: boolean;
      /** 429: сколько секунд Telegram просит подождать (`parameters.retry_after`). */
      retryAfter?: number;
    };

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];
export type ReplyMarkup =
  | { inline_keyboard: InlineKeyboard }
  | { force_reply: true; input_field_placeholder?: string; selective?: boolean };

interface BotUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
interface BotChat {
  id: number;
  type?: string;
}
export interface SentBotMessage {
  message_id: number;
  chat: BotChat;
}
interface BotPhotoSize {
  file_id: string;
  file_size?: number;
}
interface BotDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface BotMessage extends SentBotMessage {
  from?: BotUser;
  /** Когда отправлено, секунды эпохи. */
  date?: number;
  text?: string;
  /** Подпись к фото или файлу: у альбома она живёт на одном из сообщений. */
  caption?: string;
  /** Общий номер сообщений одного альбома. */
  media_group_id?: string;
  /** Размеры одного фото, от меньшего к большему. */
  photo?: BotPhotoSize[];
  document?: BotDocument;
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
  /** CLI не основной (не Claude Code): тогда его имя пишется в строке «где». */
  otherCli?: boolean;
  app: 'agentdeck' | 'outside';
  /** Кто ведёт сессию (`entrypoint` транскрипта): VS Code и терминал подписаны в первой строке. */
  client?: InboxClient;
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
  /**
   * Вопрос сессии, которую панель не ведёт (VS Code, терминал), а хук панели не
   * держит. Только для чтения: продолжение чата панелью (`--resume`) завело бы
   * копию чужой сессии, а диалог там остался бы висеть.
   */
  | { kind: 'outsideQuestion'; chatId: string; client?: InboxClient }
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
  /**
   * Что агент хочет сделать — словами: `description` вызова Bash, «Изменить
   * файл app.ts», «Открыть example.com», «gitlab: create_issue» или имя инструмента.
   */
  description?: string;
  /** Что именно спрошено — уже под маской секретов. */
  summary?: string;
  launch?: InboxLaunch;
  questions?: InboxQuestion[];
  /** Причина D-n — почему решает человек. */
  reason?: string;
  /** Чат, куда отвечать текстом (reply на сообщение бота). */
  chat?: ChatRoute;
}

/**
 * Карточка ожидания для сообщения — данные, а не готовый текст: разметка
 * собирается при каждой отправке и правке (`compose.ts`), а строка вопроса
 * меняется по шагу вызова. Тексты — уже под маской секретов, без экранирования.
 */
export interface ItemCard {
  kind: 'question' | 'permission' | 'decision';
  /** Имя папки проекта — в первой строке за меткой «📁», сразу после вида. */
  project: string;
  /** Имя сессии (чата) — последним в первой строке; нет у записей старше формата 25.10. */
  session?: string;
  /** Чужой CLI, «VS Code» или «Терминал» — между проектом и сессией. */
  via?: string;
  /** Вопрос только для чтения: где на него ответить («Ответь в VS Code — …»). */
  readOnly?: string;
  /** Группа, стадия, «из фона» — в свёрнутой цитате. */
  group?: string;
  /** Суть: что нужно (у вопроса берётся из самого вопроса). */
  title?: string;
  /** Суть — сама команда (нет своего описания): моноширинно. */
  titleIsCode?: boolean;
  /** Номер отложенного решения D-n — виден в первой строке. */
  deferredId?: string;
  /** Прежняя строка «где» — только у старых записей. */
  where?: string;
  /** Подробности в свёрнутой цитате: почему решаете вы и команда. */
  reason?: string;
  code?: string;
}

/**
 * Чат, куда уходит ответ на сообщение бота (reply): ключ чата панели, сессия,
 * проект; `outside` — сессия терминала или VS Code (сообщение — через хук).
 */
export interface ChatRoute {
  chatId: string;
  sessionId?: string;
  runKey?: string;
  projectPath?: string;
  title?: string;
  outside?: boolean;
}

/** Ожидание в отправленном сообщении. */
export interface SentItem {
  /** Куда ушёл бы ответ-reply на это ожидание. */
  chat?: ChatRoute;
  key: string;
  target: AskTarget;
  /** Что открыть в панели (`/chat?id=`); пусто — раздел чата без разговора. */
  openId: string;
  /** Текст ожидания, как его увидел человек при отправке (простой — у старых записей). */
  text: string;
  /** Карточка для разметки HTML; нет — запись старше разметки, `text` уходит как есть. */
  card?: ItemCard;
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
  /** Отложенное удаление ответа на /clear: переживает перезапуск. */
  deletes?: PendingDelete[];
  lastSentAt?: number;
}

/** Сообщение, которое бот удалит в момент `at` (мс), если оно моложе 48 часов. */
export interface PendingDelete {
  chatId: string;
  messageId: number;
  at: number;
  /** Когда сообщение отправлено, мс: старше 48 часов Telegram удалять не даёт. */
  sentAt: number;
  /**
   * Ответ на /clear. Записи без отметки остались от прежнего «Убирать
   * отвеченное» и при чтении файла отбрасываются (`store.ts`).
   */
  force?: boolean;
}

/** Почему ожидание пропало из сводки, пока висело в Telegram. */
export type Vanished = { kind: 'inPanel' } | { kind: 'stale' } | { kind: 'deferred'; id: string };

/** Исход применения ответа маршрутом панели. */
export type ApplyOutcome =
  | { ok: true }
  | { ok: false; gone: true; detail?: string }
  | { ok: false; gone?: false; detail: string };
