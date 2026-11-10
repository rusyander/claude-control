import type { TelegramOrigin } from '../telegram-core/command-port.types.ts';
import type {
  BotMessage,
  BotUpdate,
  PendingAskItem,
} from '../telegram-answers/telegram-answers.types.ts';

/**
 * Уведомления о задачах ядра в боте ответов (этап 12, D29, P191–P194). Цикл getUpdates один —
 * сервис ответов; он отдаёт сюда то, что ему не принадлежит, строками-делегатами после проверки
 * владельца. Нет крючков — поведение сервиса прежнее, до последней строки.
 */

/** Чем говорить с владельцем из крючка: токен бота и обновление-источник (отпечаток владельца). */
export interface NoticeContext {
  token: string;
  origin: TelegramOrigin;
}

export type NoticePress = NonNullable<BotUpdate['callback_query']>;

export interface TelegramNoticesHooks {
  /** Нажатие кнопки с приставкой `n:` (владелец уже проверен); `true` — обработано. */
  press(ctx: NoticeContext, press: NoticePress): Promise<boolean>;
  /** Ответ (reply) владельца на сообщение бота `to`; `true` — это подсказка уведомления, обработано. */
  reply(ctx: NoticeContext, messages: readonly BotMessage[], to: number): Promise<boolean>;
  /** `/task <текст>` и прочие команды, которых сервис ответов не знает; `true` — обработано. */
  command(ctx: NoticeContext, message: BotMessage): Promise<boolean>;
  /** Добавочные строки `/status`: живые задачи ядра. */
  statusLines(): Promise<string[]>;
  /** Тихие часы: что из готового к отправке уходит сейчас; остальное держит сам крючок (P194). */
  hold(items: readonly PendingAskItem[], now: number): readonly PendingAskItem[];
}

/** Уведомления целиком: крючки сервиса ответов + строка потока ядра (пересылка) и остановка. */
export interface TelegramNotices extends TelegramNoticesHooks {
  /** Строка журнала задачи из потока пересылки (`CoreRelayDeps.onLine`): повод перечитать вид. */
  onLine(task: { taskId: string; title: string | null }, event: { event: string | null }): void;
  /** Снять отложенные перечитывания (выход панели). */
  stop(): void;
}

/** Виды уведомлений: конец задачи, открытый MR, падение, карточка окна, запись `/task`. */
export type NoticeKind = 'done' | 'mr' | 'failed' | 'window' | 'entry';

/** Отправленное уведомление с кнопками — по нему сверяется нажатие `n:`. */
export interface NoticeMessage {
  sid: string;
  chatId: string;
  messageId: number;
  /** Соль подписи кнопок этого сообщения. */
  nonce: string;
  kind: NoticeKind;
  taskId?: string;
  /** Запись доски (`/task`) — для «В работу». */
  entryId?: string;
  /** Варианты карточки окна по порядку кнопок (`cli:<…>` / `model:<…>`). */
  offers?: string[];
  /** Адрес MR кнопкой-ссылкой (https, не loopback) — остаётся и после снятия кнопок `n:`. */
  url?: string;
  /** Метки кнопок `n:` по номеру действия — по ним сверяется нажатие (подменённая метка — отказ). */
  labels: Record<string, string>;
  /** Текст сообщения разметкой HTML — правки дописывают строку итога под ним. */
  text: string;
  at: number;
  /** Кнопки сняты: итог записан, нажимать больше нечего. */
  closed?: boolean;
}

/** Уведомление, удержанное тихими часами: строка сводки и, для карточки окна, её задача. */
export interface HeldNotice {
  key: string;
  kind: NoticeKind;
  taskId: string;
  /** Строка сводки разметкой HTML. */
  line: string;
  at: number;
  /** Карточка окна: шаг окна, на котором её удержали (после тишины — заново по живому виду). */
  windowSeq?: number;
}

/** Строка уведомителя прогонов (бот карточки), удержанная тихими часами. */
export interface HeldLine {
  chatId: string;
  /** Текст разметкой HTML, как ушёл бы сам. */
  text: string;
  at: number;
}

/** Файл `telegram-notices.json` в каталоге данных панели. */
export interface NoticesFile {
  version: 1;
  secret: string;
  nextSid: number;
  /** Ключ уведомления (`done:<task>`, `mr:<task>:<unit>`, `window:<task>:<seq>`…) → когда ушло. */
  sent: Record<string, number>;
  messages: NoticeMessage[];
  /** Ключ повтора команды по нажатию / записи (`<sid>:<действие>`, `tg:<чат>:<сообщение>`). */
  cmds: Record<string, string>;
  /** Подсказка «На доработку» (номер сообщения бота) → её уведомление. */
  prompts: Record<string, { sid: string; taskId: string; at: number }>;
  /** Записи `/task`: ключ `tg:<чат>:<сообщение>` → запись доски и номер ответа бота. */
  entries: Record<string, { entryId?: string; replied?: number; at: number }>;
  held: HeldNotice[];
  notifyHeld: HeldLine[];
  /** Задачи, чей конец уже рассмотрен (сообщён, удержан или застан до первого прохода). */
  seenEnded: string[];
  /** Последний `seq` списка у задачи в `waiting-window` — повод перечитать её вид. */
  windowSeen: Record<string, number>;
  /** Записи доски после «В работу»: ждём, стартовал ли запускатель или вернул с причиной. */
  watch: { entryId: string; sid: string; at: number }[];
  /** Последний проход по списку задач; давний (или не было) — конец задач до него не сообщается. */
  lastPumpAt?: number;
}
