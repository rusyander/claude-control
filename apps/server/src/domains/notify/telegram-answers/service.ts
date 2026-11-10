import type {
  TelegramAnswersState,
  TelegramAnswersStatus,
} from '@agentdeck/contracts/telegram-answers';
import type { Answer } from './apply.ts';
import {
  answerCallbackQuery,
  botIdOf,
  editMessageText,
  getMe,
  getUpdates,
  getWebhookInfo,
  sendMessage,
  setMyCommands,
} from './bot-api.ts';
import {
  ALREADY_CONNECTED,
  BOT_COMMANDS,
  HELP_TEXT,
  NOTHING_WAITING,
  parseCommand,
  statusText,
  type LimitShares,
  type RunningChat,
} from './commands.ts';
import { newNonce, parseCallback, signCallback, verifyCallback } from './callback-data.ts';
import { coreAskPressIntact, questionShown } from './core-ask-press.ts';
import {
  CUSTOM_PROMPT_TEXT,
  cardOf,
  readOnlyLine,
  sentItemOf,
  keyboardOf,
  messageText,
  itemLink,
  OUTCOME,
  TOAST,
} from './compose.ts';
import type { AnswersStore } from './store.ts';
import { coreAskRefusalText } from '../core-notice.ts';
import { CLEAR_REPLY_TTL_MS, clearChat, clearReplyText, flushDeletes } from './cleanup.ts';
import {
  AlbumBuffer,
  EMPTY_REPLY,
  OUTSIDE_MEDIA_NOTE,
  OUTSIDE_MEDIA_ONLY,
  UNMAPPED_REPLY,
  downloadMedia,
  mediaOf,
  sendFailed,
  sentAck,
  sentParts,
  skipNotes,
  type ChatFile,
  type MediaRef,
} from './replies.ts';
import type { SentLog } from './sent-log.ts';
import { sleep } from './sleep.ts';
import { telegramApiBase } from '../telegram-api.ts';
import type {
  NoticeContext,
  TelegramNoticesHooks,
} from '../telegram-notices/telegram-notices.types.ts';
import type { ReplyMarkup } from './telegram-answers.types.ts';
import type {
  ApplyOutcome,
  AskTarget,
  BotMessage,
  BotUpdate,
  ButtonAction,
  ChatRoute,
  PendingAskItem,
  SentItem,
  SentMessage,
  Vanished,
} from './telegram-answers.types.ts';

/**
 * Ответы из Telegram: вопрос, на который человек не ответил в панели за
 * `afterMinutes`, уходит владельцу в Telegram с кнопками; нажатие применяется
 * тем же маршрутом панели, а сообщение правится итогом и теряет кнопки.
 *
 * Опрос — длинный `getUpdates`, а не вебхук: панель живёт на локальной машине,
 * и входящего адреса у неё нет. Отсюда три жёстких правила:
 *  - бот агента (MCP-сервер или канал Telegram) этим опросом не слушается
 *    никогда — второй слушатель отнимал бы его сообщения (`same-bot.ts`);
 *  - чужой вебхук не снимается: о нём говорится статусом, решает человек;
 *  - 409 (бота слушает кто-то ещё) — остановка, а не повтор вплотную.
 *
 * Принимаются только нажатия и ответы владельца: и чат, и отправитель обязаны
 * совпасть с его id. Остальное молча отбрасывается — в журнал попадает только
 * сам факт, без содержимого.
 *
 * Ответ владельца ответом (reply) на любое сообщение бота о чате уходит в этот
 * чат текстом и картинками (`replies.ts`); не понять, в какой, — одна строка
 * объяснения, а не тишина.
 */

export interface AnswersServiceDeps {
  store: AnswersStore;
  /** Токен бота ответов: отдельный или бот карточки Telegram. */
  token: () => string | undefined;
  /** Номера ботов, которых слушает агент (`same-bot.ts`). */
  agentBotIds: () => Set<string>;
  /** Включена ли карточка Telegram целиком; выключена — опрос стоит. Не задано — да. */
  active?: () => boolean;
  /** Что сейчас ждёт человека (`collect.ts`). */
  collect: () => Promise<PendingAskItem[]>;
  /** Применить ответ маршрутом панели (`apply.ts`). */
  apply: (target: AskTarget, answer: Answer, clientId: string) => Promise<ApplyOutcome>;
  /** Сообщение владельца в чат панели или сессию вне её (`sendChatText`). */
  sendToChat?: (
    route: ChatRoute,
    text: string,
    files: readonly ChatFile[],
    clientId: string,
  ) => Promise<ApplyOutcome>;
  /** Почему ожидание пропало из сводки. */
  vanished: (target: AskTarget) => Vanished;
  /**
   * Обновление сначала предлагается окну подключения (`connect.ts`): `/start`
   * в открытое окно забирает оно, а не разбор владельца.
   */
  intercept?: (update: BotUpdate) => boolean;
  /** Идущие разговоры — для `/status`. */
  running?: () => Promise<RunningChat[]>;
  /** Загрузка окон подписки — для `/status`; неизвестна — строки нет. */
  limits?: () => Promise<LimitShares | undefined>;
  /** Что бот писал и какие команды слал владелец — для /clear (`sent-log.ts`). */
  sentLog?: SentLog;
  /**
   * Уведомления о задачах ядра (этап 12, D29): нажатия `n:`, ответы на их подсказки, `/task` и
   * незнакомые команды, строки `/status`, тихие часы. Нет — поведение до этапа 12.
   */
  notices?: TelegramNoticesHooks;
  /** Сколько собирать сообщения одного альбома с последнего пришедшего (мс). */
  albumWaitMs?: number;
  /**
   * Тишина после старта панели и после сна машины: накопившееся за ночь не
   * сыплется пачкой, пока человек, может быть, уже сидит за панелью (мс).
   */
  sendGraceMs?: number;
  log: (message: string) => void;
  now?: () => number;
  /** Как часто сверять ожидания (мс). */
  scanMs?: number;
  /** Сколько Telegram держит длинный опрос (с). */
  pollSeconds?: number;
  /** Пропажа из сводки подтверждается не сразу: панель могла перезапускаться. */
  confirmMissingMs?: number;
  startupGraceMs?: number;
  /** Не чаще одного нового сообщения за этот срок; остальное копится в следующее. */
  coalesceMs?: number;
  maxItems?: number;
}

const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
/** Две минуты тишины после старта и сна (решение владельца 25.10.2026, B7). */
export const SEND_GRACE_MS = 2 * 60_000;
/** Сверка не шла дольше этого — машина спала: таймер в сне не тикает. */
const WAKE_GAP_MS = 60_000;

export class TelegramAnswersService {
  private readonly deps: AnswersServiceDeps;
  private readonly now: () => number;
  private state: TelegramAnswersStatus = { state: 'off' };
  private abort: AbortController | undefined;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private nextSendAt = 0;
  /** До этого момента новое не отправляется (`sendGraceMs`). */
  private quietUntil = 0;
  private lastScanAt = 0;
  private bootBackoff = BACKOFF_MIN_MS;
  /** Картинки ответа на вопрос из нескольких шагов — до отправки последнего шага. */
  private readonly answerFiles = new Map<string, ChatFile[]>();
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private token: string | undefined;
  private readonly albums: AlbumBuffer;

  constructor(deps: AnswersServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    deps.store.useClock(() => this.now());
    this.albums = new AlbumBuffer(deps.albumWaitMs ?? 1_500);
  }

  status(): TelegramAnswersStatus {
    return { ...this.state };
  }

  openCount(): number {
    return this.deps.store.openItems();
  }

  /** Слушает ли опрос этот токен прямо сейчас — второй слушатель получил бы 409. */
  listensTo(token: string): boolean {
    return Boolean(this.abort) && this.token === token;
  }

  /**
   * Права и вопросы доставляет этот опрос: включён, слушает и пишет владельцу
   * без отказов. Тогда уведомление Telegram о них молчит — иначе пришло бы два
   * сообщения, и одно из них без кнопок.
   */
  covers(): boolean {
    return (
      this.deps.store.settings.enabled &&
      this.deps.active?.() !== false &&
      this.state.state === 'polling' &&
      !this.state.detail
    );
  }

  private setState(state: TelegramAnswersState, extra: Omit<TelegramAnswersStatus, 'state'> = {}) {
    if (this.state.state !== state) this.deps.log(`telegram-answers: ${state}`);
    this.state = {
      state,
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...((extra.bot ?? this.state.bot) ? { bot: extra.bot ?? this.state.bot } : {}),
      since: new Date(this.now()).toISOString(),
    };
  }

  /** Все действия над записью — по очереди: нажатие и сверка не правят одно сообщение разом. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    this.token = undefined;
  }

  /** Запуск и перезапуск — после сохранения настройки и кнопкой «Перезапустить». */
  async restart(): Promise<TelegramAnswersStatus> {
    this.stop();
    const generation = this.generation;
    this.state = { state: 'off' };
    this.bootBackoff = BACKOFF_MIN_MS;
    await this.boot(generation);
    return this.status();
  }

  private async boot(generation: number): Promise<void> {
    const settings = this.deps.store.settings;
    // Настройка сброшена потерей файла — человек видит причину, а не просто «выключено».
    const lost = this.deps.store.lost;
    if (!settings.enabled || this.deps.active?.() === false) {
      return this.setState('off', lost ? { detail: `файл ответов был повреждён: ${lost}` } : {});
    }
    const token = this.deps.token();
    const botId = botIdOf(token);
    if (!token || !botId) return this.setState('no-token');
    if (!settings.ownerId) return this.setState('owner-missing');
    if (this.deps.agentBotIds().has(botId)) {
      return this.setState('same-bot', {
        detail: 'для ответов из Telegram нужен отдельный бот',
      });
    }
    const me = await getMe(token);
    if (generation !== this.generation) return;
    if (!me.ok) {
      if (me.status === 401 || me.status === 404) {
        return this.setState('unauthorized', { detail: me.description });
      }
      this.setState('error', { detail: me.description });
      // Сеть легла надолго — повтор всё реже, до минуты, а не каждые 5 с.
      const delay = this.bootBackoff;
      this.bootBackoff = Math.min(delay * 2, BACKOFF_MAX_MS);
      return this.retryBoot(generation, delay);
    }
    this.bootBackoff = BACKOFF_MIN_MS;
    const bot = me.result.username ? `@${me.result.username}` : undefined;
    const hook = await getWebhookInfo(token);
    if (generation !== this.generation) return;
    if (hook.ok && hook.result.url) {
      // Чужой вебхук не снимаем: его ставил человек или другой сервис, и
      // `deleteWebhook` молча сломал бы их.
      return this.setState('webhook', {
        detail: 'у бота стоит вебхук — опрос невозможен',
        ...(bot ? { bot } : {}),
      });
    }
    this.token = token;
    this.startedAt = this.now();
    this.lastScanAt = this.startedAt;
    this.quietUntil = this.startedAt + (this.deps.sendGraceMs ?? SEND_GRACE_MS);
    this.setState('polling', bot ? { bot } : {});
    this.abort = new AbortController();
    void this.pollLoop(generation, token, this.abort.signal);
    void this.publishCommands(token);
    this.scanTimer = setInterval(() => {
      void this.serial(() => this.scan(generation)).catch((error: unknown) =>
        this.deps.log(`telegram-answers: scan failed: ${errorText(error)}`),
      );
    }, this.deps.scanMs ?? 5_000);
    this.scanTimer.unref?.();
  }

  /** Меню команд бота: по-английски для всех и по-русски для русского Telegram. */
  private async publishCommands(token: string): Promise<void> {
    for (const [language, commands] of [
      [undefined, BOT_COMMANDS.en],
      ['ru', BOT_COMMANDS.ru],
    ] as const) {
      const done = await setMyCommands(token, commands, language);
      if (!done.ok) this.deps.log(`telegram-answers: setMyCommands failed (${done.status})`);
    }
  }

  private retryBoot(generation: number, ms: number): void {
    const timer = setTimeout(() => {
      if (generation === this.generation) void this.boot(generation);
    }, ms);
    timer.unref?.();
  }

  private async pollLoop(generation: number, token: string, signal: AbortSignal): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    const seconds = this.deps.pollSeconds ?? 50;
    while (generation === this.generation && !signal.aborted) {
      const updates = await getUpdates(token, this.deps.store.offset, seconds, signal);
      if (generation !== this.generation || signal.aborted) return;
      if (!updates.ok) {
        if (updates.status === 409) {
          // Бота слушает кто-то ещё. Повтор вплотную отнимал бы обновления у
          // обоих — стоим до сохранения настройки или «Перезапустить».
          this.setState('conflict', { detail: updates.description });
          this.stopPolling();
          return;
        }
        if (updates.status === 401 || updates.status === 404) {
          this.setState('unauthorized', { detail: updates.description });
          this.stopPolling();
          return;
        }
        this.setState('error', { detail: updates.description });
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        continue;
      }
      backoff = BACKOFF_MIN_MS;
      if (this.state.state !== 'polling') this.setState('polling');
      for (const update of updates.result ?? []) {
        await this.serial(() => this.handleUpdate(update)).catch((error: unknown) =>
          this.deps.log(`telegram-answers: update failed: ${errorText(error)}`),
        );
        // Номер — после разбора: упавшая на полпути панель получит обновление
        // ещё раз, а не потеряет нажатие.
        this.deps.store.setOffset(update.update_id + 1);
      }
    }
  }

  private stopPolling(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
  }

  // ── сверка ожиданий ──────────────────────────────────────────────────────

  /** Один проход: закрыть пропавшие ожидания, отправить созревшие. Открыт для тестов. */
  async scan(generation = this.generation): Promise<void> {
    if (generation !== this.generation || this.state.state !== 'polling' || !this.token) return;
    // Выключили не через PUT ответов (главный выключатель карточки, файл) — опрос
    // стоит с ближайшего прохода, а не до перезапуска панели.
    if (!this.deps.store.settings.enabled || this.deps.active?.() === false) {
      this.stop();
      this.setState('off');
      return;
    }
    const token = this.token;
    this.noticeWake();
    await flushDeletes(this.cleanupContext(token));
    const items = await this.deps.collect();
    const now = this.now();
    const live = new Map(items.map((item) => [item.key, item]));
    let dirty = false;
    for (const message of this.deps.store.open()) {
      let changed = false;
      for (const item of message.items) {
        if (item.state !== 'open') continue;
        const fresh = live.get(item.key);
        if (fresh) {
          if (item.missingSince !== undefined) {
            delete item.missingSince;
            dirty = true;
          }
          if (retarget(item, fresh)) changed = true;
          continue;
        }
        if (item.missingSince === undefined) {
          item.missingSince = now;
          dirty = true;
        }
        const settle = this.deps.confirmMissingMs ?? 15_000;
        const grace = this.deps.startupGraceMs ?? 45_000;
        if (now - item.missingSince < settle || now - this.startedAt < grace) continue;
        this.closeVanished(item, now);
        changed = true;
      }
      if (changed) await this.render(token, message);
    }
    // Проход без перемен файл не пишет: сверка идёт каждые 5 с.
    if (dirty) this.deps.store.save();

    const afterMs = this.deps.store.settings.afterMinutes * 60_000;
    const due = items.filter(
      (item) =>
        !this.deps.store.wasSent(item.key) &&
        (item.immediate || now - Date.parse(item.askedAt) >= afterMs),
    );
    // Тихие часы (этап 12, P194): удержанное держит крючок уведомлений; нет крючка — всё сразу.
    const ready = this.deps.notices ? this.deps.notices.hold(due, now) : due;
    if (ready.length === 0 || now < this.nextSendAt || now < this.quietUntil) return;
    const lastSentAt = this.deps.store.lastSentAt;
    if (lastSentAt && now - lastSentAt < (this.deps.coalesceMs ?? 60_000)) return;
    await this.send(token, ready.slice(0, this.deps.maxItems ?? 8));
  }

  /**
   * Сверки долго не было — машина спала (таймеры во сне не идут). После
   * пробуждения та же тишина, что после старта: человек мог открыть крышку,
   * чтобы ответить в панели.
   */
  private noticeWake(): void {
    const now = this.now();
    const gap = Math.max(WAKE_GAP_MS, 3 * (this.deps.scanMs ?? 5_000));
    if (now - this.lastScanAt > gap) {
      this.quietUntil = now + (this.deps.sendGraceMs ?? SEND_GRACE_MS);
      this.startedAt = now;
    }
    this.lastScanAt = now;
  }

  private closeVanished(item: SentItem, now: number): void {
    const why = this.deps.vanished(item.target);
    item.state = 'done';
    delete item.missingSince;
    item.outcome =
      why.kind === 'inPanel'
        ? OUTCOME.inPanel(now)
        : why.kind === 'coreOnly'
          ? OUTCOME.coreOnly(now)
          : OUTCOME.stale(now);
  }

  private async send(token: string, items: PendingAskItem[]): Promise<boolean> {
    const ownerId = this.deps.store.settings.ownerId;
    const message: SentMessage = {
      sid: this.deps.store.nextSid(),
      chatId: ownerId,
      messageId: 0,
      nonce: newNonce(),
      sentAt: new Date(this.now()).toISOString(),
      items: items.map(sentItemOf),
      actions: {},
      nextAction: 0,
    };
    return this.deliver(token, message);
  }

  /** Отправить новое сообщение и записать его. */
  private async deliver(token: string, message: SentMessage): Promise<boolean> {
    const sign = (n: number) => signCallback(this.deps.store.secret, message.sid, n, message.nonce);
    const keyboard = keyboardOf(message, sign);
    const sent = await sendMessage(token, message.chatId, messageText(message, linksOf(message)), {
      inline_keyboard: keyboard,
    });
    if (!sent.ok) {
      // Владелец не начинал разговор с ботом (403) или сеть легла — не долбим,
      // повтор через минуту.
      this.nextSendAt = this.now() + 60_000;
      this.deps.log(`telegram-answers: send failed (${sent.status}): ${sent.description}`);
      if (sent.status === 403 || sent.status === 400) {
        this.setState('polling', {
          detail: `не удалось написать владельцу: ${sent.description}`,
        });
      }
      return false;
    }
    message.messageId = sent.result.message_id;
    // Прошло — прежняя подробность «не удалось написать» больше не правда.
    if (this.state.detail) this.setState('polling');
    this.deps.store.add(message, this.now());
    this.remember(message.chatId, message.messageId, 'bot');
    return true;
  }

  private cleanupContext(token: string) {
    return {
      token,
      store: this.deps.store,
      sentLog: this.deps.sentLog,
      now: this.now(),
      log: this.deps.log,
    };
  }

  private remember(chatId: string, messageId: number, kind: 'bot' | 'owner'): void {
    this.deps.sentLog?.record({ chatId, messageId, at: this.now(), kind });
  }

  /** Сообщение от бота с записью для /clear. */
  private async say(
    token: string,
    chatId: string,
    text: string,
    markup?: ReplyMarkup,
    replyTo?: number,
  ) {
    const sent = await sendMessage(token, chatId, text, markup, replyTo);
    if (sent.ok) this.remember(chatId, sent.result.message_id, 'bot');
    return sent;
  }

  /**
   * Переписать сообщение по его состоянию. Отвечено всё — оно сразу
   * сворачивается в строки итога без кнопок и подробностей (`messageText`):
   * ничего не удаляется, /clear убирает руками.
   */
  private async render(token: string, message: SentMessage): Promise<void> {
    const open = message.items.some((item) => item.state === 'open');
    if (!open && !message.closedAt) message.closedAt = new Date(this.now()).toISOString();
    const sign = (n: number) => signCallback(this.deps.store.secret, message.sid, n, message.nonce);
    const keyboard = open ? keyboardOf(message, sign) : [];
    const edited = await editMessageText(
      token,
      message.chatId,
      message.messageId,
      messageText(message, linksOf(message)),
      keyboard,
    );
    if (!edited.ok && !/not modified/i.test(edited.description)) {
      this.deps.log(`telegram-answers: edit failed (${edited.status}): ${edited.description}`);
    }
    this.deps.store.save();
  }

  // ── обновления Telegram ───────────────────────────────────────────────────

  private isOwner(chatId: number | undefined, fromId: number | undefined): boolean {
    const owner = this.deps.store.settings.ownerId;
    return Boolean(owner) && String(chatId) === owner && String(fromId) === owner;
  }

  /** Контекст крючка уведомлений: обновление-источник — отпечаток владельца для ядра. */
  private noticeContext(token: string, chatId: number, fromId: number): NoticeContext {
    return {
      token,
      origin: {
        apiBase: telegramApiBase(),
        botId: botIdOf(token) ?? '',
        chatId: String(chatId),
        fromId: String(fromId),
      },
    };
  }

  /** Разобрать одно обновление. Открыт для тестов. */
  async handleUpdate(update: BotUpdate): Promise<void> {
    const token = this.token;
    if (!token) return;
    if (this.deps.intercept?.(update)) return;
    if (update.callback_query) return this.handlePress(token, update.callback_query);
    if (update.message) return this.handleReply(token, update.message);
  }

  private async handlePress(
    token: string,
    press: NonNullable<BotUpdate['callback_query']>,
  ): Promise<void> {
    if (!this.isOwner(press.message?.chat.id, press.from.id)) {
      this.deps.log('telegram-answers: press from a non-owner ignored');
      return;
    }
    // Кнопка уведомления ядра (`n:`) — не ожидание ответов: её разбирает крючок уведомлений.
    if (this.deps.notices && press.data?.startsWith('n:') && press.message) {
      const ctx = this.noticeContext(token, press.message.chat.id, press.from.id);
      if (await this.deps.notices.press(ctx, press)) return;
    }
    const toast = (text: string) => answerCallbackQuery(token, press.id, text);
    const parsed = parseCallback(press.data);
    const message = parsed ? this.deps.store.bySid(parsed.sid) : undefined;
    if (
      !parsed ||
      !message ||
      message.messageId !== press.message?.message_id ||
      !verifyCallback(this.deps.store.secret, parsed, message.nonce)
    ) {
      if (parsed && message) this.deps.log('telegram-answers: press with a bad signature ignored');
      await toast(TOAST.stale);
      return;
    }
    const action = message.actions[String(parsed.action)];
    const item = action ? message.items[action.item] : undefined;
    if (!action || !item || item.state !== 'open') {
      await toast(TOAST.answered);
      return;
    }
    // Вопрос ядра (этап 12, P189): подпись нажатой кнопки и вопрос, как их показал Telegram, —
    // те же, что в файле ответов; иначе ни одной команды, свежая копия следующей сверкой.
    if (!this.coreAskIntact(message, item, press)) {
      return this.freshCopy(token, message, item, toast);
    }
    const clientId = `tg-${message.sid}-${parsed.action}`;
    switch (action.act) {
      case 'allow':
      case 'deny':
        return this.finish(token, message, item, toast, clientId, {
          kind: 'decision',
          behavior: action.act,
        });
      case 'pick':
      case 'toggle':
      case 'done':
        return this.pick(token, message, item, action, toast, clientId);
      case 'custom': {
        const prompt = await this.say(
          token,
          message.chatId,
          CUSTOM_PROMPT_TEXT,
          { force_reply: true, input_field_placeholder: 'Свой ответ', selective: true },
          message.messageId,
        );
        if (prompt.ok) {
          item.customPrompt = prompt.result.message_id;
          this.deps.store.save();
          await toast(TOAST.customPrompt);
        } else {
          await toast(TOAST.failed);
        }
        return;
      }
      case 'expand':
        return this.expand(token, message, item, toast);
    }
  }

  /** Вопрос ядра: показанное Telegram совпало с тем, что бот показал бы сейчас (P189). */
  private coreAskIntact(
    message: SentMessage,
    item: SentItem,
    press: NonNullable<BotUpdate['callback_query']>,
  ): boolean {
    if (item.target.kind !== 'coreAsk') return true;
    const sign = (n: number) => signCallback(this.deps.store.secret, message.sid, n, message.nonce);
    const expected = keyboardOf(message, sign)
      .flat()
      .find((button) => button.callback_data === press.data)?.text;
    return coreAskPressIntact(item.target, press, expected);
  }

  /** Ничего не отправлено: сообщение закрыто, следующая сверка пришлёт свежую копию вопроса. */
  private async freshCopy(
    token: string,
    message: SentMessage,
    item: SentItem,
    toast: (text: string) => Promise<unknown>,
  ): Promise<void> {
    item.state = 'done';
    item.outcome = OUTCOME.stale(this.now());
    this.deps.store.forget(item.key);
    await this.render(token, message);
    await toast(TOAST.changed);
  }

  /** Вопрос из сводного сообщения — отдельным сообщением со всеми вариантами. */
  private async expand(
    token: string,
    message: SentMessage,
    item: SentItem,
    toast: (text: string) => Promise<unknown>,
  ): Promise<void> {
    const single: SentMessage = {
      sid: this.deps.store.nextSid(),
      chatId: message.chatId,
      messageId: 0,
      nonce: newNonce(),
      sentAt: new Date(this.now()).toISOString(),
      items: [{ ...item, state: 'open' }],
      actions: {},
      nextAction: 0,
    };
    if (!(await this.deliver(token, single))) {
      await toast(TOAST.failed);
      return;
    }
    item.state = 'done';
    item.outcome = OUTCOME.expanded();
    await this.render(token, message);
    await toast(TOAST.accepted);
  }

  private async pick(
    token: string,
    message: SentMessage,
    item: SentItem,
    action: ButtonAction,
    toast: (text: string) => Promise<unknown>,
    clientId: string,
  ): Promise<void> {
    const step = item.step ?? 0;
    const question = item.questions?.[step];
    if (!question || action.step !== step) {
      await toast(TOAST.answered);
      return;
    }
    const picks = (item.picks ??= []);
    const chosen = picks[step] ?? [];
    if (action.act === 'toggle') {
      const label = question.options[action.option ?? -1]?.label;
      if (label === undefined) return void (await toast(TOAST.stale));
      picks[step] = chosen.includes(label)
        ? chosen.filter((known) => known !== label)
        : [...chosen, label];
      await this.render(token, message);
      await toast(TOAST.accepted);
      return;
    }
    if (action.act === 'pick') {
      const label = question.options[action.option ?? -1]?.label;
      if (label === undefined) return void (await toast(TOAST.stale));
      picks[step] = [label];
    } else if (chosen.length === 0) {
      await toast(TOAST.pickFirst);
      return;
    }
    await this.advance(token, message, item, toast, clientId);
  }

  /** Вопрос отвечен: следующий вопрос того же вызова или ответ целиком. */
  private async advance(
    token: string,
    message: SentMessage,
    item: SentItem,
    toast: (text: string) => Promise<unknown>,
    clientId: string,
  ): Promise<void> {
    const questions = item.questions ?? [];
    const step = item.step ?? 0;
    if (step + 1 < questions.length) {
      item.step = step + 1;
      await this.render(token, message);
      await toast(TOAST.next);
      return;
    }
    const files = this.answerFiles.get(item.key) ?? [];
    await this.finish(token, message, item, toast, clientId, {
      kind: 'questions',
      questions,
      picks: item.picks ?? [],
      ...(files.length > 0 ? { files } : {}),
    });
  }

  /** Применить ответ и записать итог в сообщение. */
  private async finish(
    token: string,
    message: SentMessage,
    item: SentItem,
    toast: (text: string) => Promise<unknown>,
    clientId: string,
    answer: Answer,
  ): Promise<void> {
    // Вопрос панели уходит словом в разговор: маршрут сам не знает, ждёт ли
    // вопрос ответа, и устаревшее нажатие стало бы лишним сообщением агенту.
    // Сверка по живому списку — до отправки.
    if (item.target.kind === 'question' && !(await this.stillOpen(item))) {
      item.state = 'done';
      item.outcome = OUTCOME.stale(this.now());
      this.answerFiles.delete(item.key);
      await this.render(token, message);
      await toast(TOAST.stale);
      return;
    }
    const outcome = await this.deps.apply(item.target, answer, clientId);
    const now = this.now();
    if (outcome.ok) {
      this.answerFiles.delete(item.key);
      item.state = 'done';
      item.outcome = outcomeLine(answer, now);
      await this.render(token, message);
      await toast(TOAST.accepted);
      return;
    }
    if (outcome.gone) {
      // Ответить уже нечего: решили в панели, ход кончился, вопрос отозван.
      this.closeVanished(item, now);
      await this.render(token, message);
      await toast(item.outcome?.startsWith('💻') ? TOAST.answered : TOAST.stale);
      return;
    }
    if (outcome.coreOnly) {
      // Вопрос ядра ждёт ответа, но не отсюда: кнопки снимаются (повтор дал бы тот же отказ),
      // строка итога называет, где ответить, — без «Не получилось» и без «Уже не актуально».
      this.answerFiles.delete(item.key);
      item.state = 'done';
      item.outcome = OUTCOME.coreOnly(now);
      await this.render(token, message);
      await toast(TOAST.coreOnly);
      return;
    }
    if (outcome.changed) return this.freshCopy(token, message, item, toast);
    if (outcome.rebind) {
      // Кнопки остаются: после новой привязки то же нажатие пройдёт (ключ повтора уже новый).
      this.deps.log(`telegram-answers: core refused the chat owner: ${outcome.detail}`);
      await toast(TOAST.rebind);
      return;
    }
    this.deps.log(`telegram-answers: answer refused: ${outcome.detail}`);
    await toast(TOAST.failed);
  }

  /** Ожидание ещё в живом списке; список не получен — не открыто (не шлём вслепую). */
  private async stillOpen(item: SentItem): Promise<boolean> {
    try {
      return (await this.deps.collect()).some((live) => live.key === item.key);
    } catch {
      return false;
    }
  }

  /**
   * Сообщение владельца. Команда — команда. Ответ (reply) на сообщение бота:
   * на открытый вопрос — ответ на него, на всё остальное о чате — сообщение в
   * этот чат. Альбом собирается целиком (`AlbumBuffer`) и уходит одной отправкой.
   */
  private async handleReply(token: string, reply: BotMessage): Promise<void> {
    if (!this.isOwner(reply.chat.id, reply.from?.id)) {
      this.deps.log('telegram-answers: message from a non-owner ignored');
      return;
    }
    const command = parseCommand(reply.text);
    if (command && command !== 'other') {
      this.remember(String(reply.chat.id), reply.message_id, 'owner');
      return this.command(token, command);
    }
    // `/task <текст>` и прочие незнакомые команды — крючку уведомлений; не взял — как прежде.
    if (command === 'other' && this.deps.notices && reply.from) {
      const ctx = this.noticeContext(token, reply.chat.id, reply.from.id);
      if (await this.deps.notices.command(ctx, reply)) {
        this.remember(String(reply.chat.id), reply.message_id, 'owner');
        return;
      }
    }
    const group = reply.media_group_id;
    if (group) {
      this.albums.add(group, reply, (messages) => {
        void this.serial(() => this.routeReply(token, messages)).catch((error: unknown) =>
          this.deps.log(`telegram-answers: album failed: ${errorText(error)}`),
        );
      });
      return;
    }
    return this.routeReply(token, [reply]);
  }

  /** Куда ответ (reply) владельца: открытый вопрос, чат или никуда (объяснение). */
  private async routeReply(token: string, messages: readonly BotMessage[]): Promise<void> {
    const ownerId = this.deps.store.settings.ownerId;
    const text = messages.map((one) => (one.text ?? one.caption)?.trim()).find(Boolean) ?? '';
    const refs: MediaRef[] = [];
    let wrongType = 0;
    for (const one of messages) {
      const media = mediaOf(one);
      refs.push(...media.refs);
      wrongType += media.wrongType;
    }
    const to = messages.map((one) => one.reply_to_message?.message_id).find(Boolean);
    if (!to) {
      await this.say(token, ownerId, HELP_TEXT);
      return;
    }
    // Ответ на подсказку уведомления ядра («На доработку») — крючку уведомлений.
    const first = messages[0];
    if (this.deps.notices && first?.from) {
      const ctx = this.noticeContext(token, first.chat.id, first.from.id);
      if (await this.deps.notices.reply(ctx, messages, to)) return;
    }
    // Вопрос ядра задач: ответ `answer` — суд `human-strict`, Telegram его не доказывает (ни числа
    // страницы панели, ни подписи ключом телефона). Не пересылаем — отказ и где ответить.
    const coreAsk = this.deps.sentLog?.find(ownerId, to, this.now())?.coreAsk;
    if (coreAsk) {
      await this.say(token, ownerId, coreAskRefusalText(coreAsk.deepLink));
      return;
    }
    const clientId = `tg-r${messages[0]!.message_id}`;
    const question = this.openQuestionFor(to);
    // Вопрос только для чтения: ни ответом, ни сообщением в чат — ход панели
    // завёл бы копию чужой сессии. Объясняем, где ответить.
    if (question?.item.target.kind === 'outsideQuestion') {
      await this.say(token, ownerId, readOnlyLine(question.item.target.client));
      return;
    }
    // Вопрос ядра (P189): ответ на само сообщение вопроса — только если Telegram показал его тем же
    // вопросом; «Свой ответ» уже прошёл ту же сверку при нажатии.
    const quoted = messages.find(
      (one) => one.reply_to_message?.message_id === to,
    )?.reply_to_message;
    if (
      question?.item.target.kind === 'coreAsk' &&
      question.message.messageId === to &&
      !questionShown(question.item.target, quoted?.text)
    ) {
      return this.freshCopy(token, question.message, question.item, (line) =>
        this.say(token, ownerId, line),
      );
    }
    if (question) {
      return this.answerByReply(token, question, text, refs, wrongType, clientId);
    }
    const route = this.routeFor(to);
    if (!route) {
      await this.say(token, ownerId, UNMAPPED_REPLY);
      return;
    }
    if (route.outside) {
      const notes = refs.length + wrongType > 0 ? [OUTSIDE_MEDIA_NOTE] : [];
      if (!text) {
        await this.say(token, ownerId, notes.length ? OUTSIDE_MEDIA_ONLY : EMPTY_REPLY);
        return;
      }
      return this.toChat(token, route, text, [], [], notes, clientId);
    }
    const { files, kinds, skips } = await downloadMedia(token, refs, this.now());
    const notes = skipNotes({ ...skips, wrongType: skips.wrongType + wrongType });
    if (!text && files.length === 0) {
      await this.say(token, ownerId, [EMPTY_REPLY, ...notes].join(' · '));
      return;
    }
    return this.toChat(token, route, text, files, kinds, notes, clientId);
  }

  private async toChat(
    token: string,
    route: ChatRoute,
    text: string,
    files: readonly ChatFile[],
    kinds: readonly MediaRef['kind'][],
    notes: readonly string[],
    clientId: string,
  ): Promise<void> {
    const ownerId = this.deps.store.settings.ownerId;
    const sent: ApplyOutcome = this.deps.sendToChat
      ? await this.deps.sendToChat(route, text, files, clientId)
      : { ok: false, detail: 'нет маршрута' };
    if (!sent.ok) {
      this.deps.log(`telegram-answers: reply refused: ${sent.gone ? 'gone' : sent.detail}`);
      await this.say(token, ownerId, sendFailed(route));
      return;
    }
    await this.say(token, ownerId, sentAck(route, kinds, Boolean(text), notes));
  }

  /**
   * Ответ на открытый вопрос: текст — выбор шага, картинки — с ответом в чат
   * панели. Вопрос сессии вне панели картинок не принимает — так и сказано.
   */
  private async answerByReply(
    token: string,
    found: { message: SentMessage; item: SentItem },
    text: string,
    refs: readonly MediaRef[],
    wrongType: number,
    clientId: string,
  ): Promise<void> {
    const { message, item } = found;
    const ownerId = this.deps.store.settings.ownerId;
    const panel = item.target.kind === 'question';
    let notes: string[] = [];
    let kinds: MediaRef['kind'][] = [];
    if (refs.length + wrongType > 0 && !panel) notes = [OUTSIDE_MEDIA_NOTE];
    if (refs.length + wrongType > 0 && panel) {
      const got = await downloadMedia(token, refs, this.now());
      notes = skipNotes({ ...got.skips, wrongType: got.skips.wrongType + wrongType });
      kinds = got.kinds;
      if (got.files.length) {
        this.answerFiles.set(item.key, [...(this.answerFiles.get(item.key) ?? []), ...got.files]);
      }
    }
    if (!text && kinds.length === 0) {
      await this.say(token, ownerId, [EMPTY_REPLY, ...notes].join(' · '));
      return;
    }
    const picks = (item.picks ??= []);
    picks[item.step ?? 0] = text ? [text] : [];
    const silent = () => Promise.resolve();
    await this.advance(token, message, item, silent, `${clientId}-${message.sid}`);
    // Без вложений итог виден в самом сообщении; с ними — строкой, что ушло.
    if (kinds.length > 0 || notes.length > 0) {
      const head = kinds.length
        ? `📎 Отправлено: ${sentParts(kinds, Boolean(text))}`
        : '✉️ Ответ отправлен';
      await this.say(token, ownerId, [head, ...notes].join(' · '));
    }
  }

  /** Открытый вопрос, на сообщение которого (или на «Свой ответ» к нему) ответили. */
  private openQuestionFor(to: number): { message: SentMessage; item: SentItem } | undefined {
    for (const message of this.deps.store.open()) {
      for (const item of message.items) {
        if (item.state !== 'open' || !item.questions?.length) continue;
        if (item.customPrompt === to || message.messageId === to) return { message, item };
      }
    }
    return undefined;
  }

  /**
   * Чат, о котором сообщение бота: запись ожидания (открытого или закрытого,
   * включая его «Свой ответ») или запись уведомления в журнале отправленного.
   */
  private routeFor(to: number): ChatRoute | undefined {
    for (const message of this.deps.store.messages()) {
      const hit =
        message.messageId === to
          ? message.items.find((item) => item.chat)
          : message.items.find((item) => item.customPrompt === to && item.chat);
      if (hit?.chat) return hit.chat;
    }
    return this.deps.sentLog?.find(this.deps.store.settings.ownerId, to, this.now())?.route;
  }

  // ── команды владельца ─────────────────────────────────────────────────────

  private async command(token: string, command: 'status' | 'waiting' | 'help' | 'start' | 'clear') {
    const chatId = this.deps.store.settings.ownerId;
    switch (command) {
      case 'status':
        await this.say(token, chatId, await this.statusLine());
        return;
      case 'waiting':
        await this.sendWaiting(token);
        return;
      case 'start':
        await this.say(token, chatId, ALREADY_CONNECTED);
        return;
      case 'clear':
        await this.clear(token, chatId);
        return;
      default:
        await this.say(token, chatId, HELP_TEXT);
    }
  }

  /** /clear: убрать известное, ждущее оставить; ответ сам уходит через 30 с. */
  private async clear(token: string, chatId: string): Promise<void> {
    const deleted = await clearChat(this.cleanupContext(token), chatId);
    const reply = await this.say(
      token,
      chatId,
      clearReplyText(deleted, this.deps.store.openItems()),
    );
    if (!reply.ok) return;
    this.deps.store.scheduleDelete({
      chatId,
      messageId: reply.result.message_id,
      at: this.now() + CLEAR_REPLY_TTL_MS,
      sentAt: this.now(),
      force: true,
    });
  }

  private async statusLine(): Promise<string> {
    const [running, waiting, limits] = await Promise.all([
      this.deps.running?.().catch(() => []) ?? Promise.resolve([]),
      this.deps.collect().then(
        (items) => items.length,
        () => 0,
      ),
      this.deps.limits?.().catch(() => undefined) ?? Promise.resolve(undefined),
    ]);
    const text = statusText({ running, waiting, ...(limits ? { limits } : {}), now: this.now() });
    // Живые задачи ядра (этап 12, P193) — строками крючка уведомлений под сводкой панели.
    const extra = (await this.deps.notices?.statusLines().catch(() => [])) ?? [];
    return extra.length ? [text, ...extra].join('\n') : text;
  }

  /**
   * `/waiting`: всё, что ждёт, — сейчас, не дожидаясь `afterMinutes`. Ожидание,
   * уже висящее в прежнем сообщении, там закрывается строкой «ниже» и уходит в
   * новое: две живые кнопки на одно ожидание путали бы, какая из них настоящая.
   */
  private async sendWaiting(token: string): Promise<void> {
    const items = await this.deps.collect();
    if (items.length === 0) {
      await this.say(token, this.deps.store.settings.ownerId, NOTHING_WAITING);
      return;
    }
    const keys = new Set(items.map((item) => item.key));
    // Сначала новое, потом закрыть прежнее: не дошло новое — прежние кнопки живы,
    // и ожидание не остаётся вовсе без кнопок.
    const previous = [...this.deps.store.open()];
    const size = this.deps.maxItems ?? 8;
    let delivered = true;
    for (let at = 0; at < items.length; at += size) {
      delivered = (await this.send(token, items.slice(at, at + size))) && delivered;
    }
    if (!delivered) return;
    for (const message of previous) {
      let moved = false;
      for (const item of message.items) {
        if (item.state !== 'open' || !keys.has(item.key)) continue;
        item.state = 'done';
        item.outcome = OUTCOME.expanded();
        moved = true;
      }
      if (moved) await this.render(token, message);
    }
  }
}

function outcomeLine(answer: Answer, at: number): string {
  if (answer.kind === 'decision') {
    return answer.behavior === 'allow' ? OUTCOME.allowed(at) : OUTCOME.denied(at);
  }
  const text =
    answer.questions.length <= 1
      ? (answer.picks[0] ?? []).join(', ')
      : answer.picks.map((chosen) => chosen.join(', ')).join(' / ');
  // Ответ одними картинками: в строке итога — что ушло, а не пустое «Ответ:».
  const files = answer.files?.length ?? 0;
  return OUTCOME.answer(text.trim() || `📎 ${files > 1 ? 'картинки' : 'картинка'}`, at);
}

/**
 * Тот же вызов сменил способ ответа: хук взял вопрос сессии вне панели — кнопки
 * появляются в том же сообщении; отпустил, а вопрос висит — уходят. Второго
 * сообщения на одно ожидание нет. `true` — сообщение надо переписать.
 */
function retarget(item: SentItem, fresh: PendingAskItem): boolean {
  if (fresh.target.kind === item.target.kind) return false;
  item.target = fresh.target;
  item.card = cardOf(fresh);
  if (fresh.chat) item.chat = fresh.chat;
  return true;
}

function linksOf(message: SentMessage): string[] {
  return message.items.map(itemLink);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
