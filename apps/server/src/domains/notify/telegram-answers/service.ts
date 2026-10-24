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
} from './bot-api.ts';
import { newNonce, parseCallback, signCallback, verifyCallback } from './callback-data.ts';
import {
  customPromptText,
  itemText,
  keyboardOf,
  messageText,
  OUTCOME,
  panelLink,
  TOAST,
} from './compose.ts';
import type { AnswersStore } from './store.ts';
import type {
  ApplyOutcome,
  AskTarget,
  BotMessage,
  BotUpdate,
  ButtonAction,
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
 */

export interface AnswersServiceDeps {
  store: AnswersStore;
  /** Токен бота ответов: отдельный или бот карточки Telegram. */
  token: () => string | undefined;
  /** Номера ботов, которых слушает агент (`same-bot.ts`). */
  agentBotIds: () => Set<string>;
  /** Что сейчас ждёт человека (`collect.ts`). */
  collect: () => Promise<PendingAskItem[]>;
  /** Применить ответ маршрутом панели (`apply.ts`). */
  apply: (target: AskTarget, answer: Answer, clientId: string) => Promise<ApplyOutcome>;
  /** Почему ожидание пропало из сводки. */
  vanished: (target: AskTarget) => Vanished;
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

export class TelegramAnswersService {
  private readonly deps: AnswersServiceDeps;
  private readonly now: () => number;
  private state: TelegramAnswersStatus = { state: 'off' };
  private abort: AbortController | undefined;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private nextSendAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private token: string | undefined;

  constructor(deps: AnswersServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  status(): TelegramAnswersStatus {
    return { ...this.state };
  }

  openCount(): number {
    return this.deps.store.openItems();
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
    await this.boot(generation);
    return this.status();
  }

  private async boot(generation: number): Promise<void> {
    const settings = this.deps.store.settings;
    // Настройка сброшена потерей файла — человек видит причину, а не просто «выключено».
    const lost = this.deps.store.lost;
    if (!settings.enabled) {
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
      return this.retryBoot(generation, BACKOFF_MIN_MS);
    }
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
    this.setState('polling', bot ? { bot } : {});
    this.abort = new AbortController();
    void this.pollLoop(generation, token, this.abort.signal);
    this.scanTimer = setInterval(() => {
      void this.serial(() => this.scan(generation)).catch((error: unknown) =>
        this.deps.log(`telegram-answers: scan failed: ${errorText(error)}`),
      );
    }, this.deps.scanMs ?? 5_000);
    this.scanTimer.unref?.();
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
    const token = this.token;
    const items = await this.deps.collect();
    const now = this.now();
    const live = new Set(items.map((item) => item.key));
    for (const message of this.deps.store.open()) {
      let changed = false;
      for (const item of message.items) {
        if (item.state !== 'open') continue;
        if (live.has(item.key)) {
          delete item.missingSince;
          continue;
        }
        item.missingSince ??= now;
        const settle = this.deps.confirmMissingMs ?? 15_000;
        const grace = this.deps.startupGraceMs ?? 45_000;
        if (now - item.missingSince < settle || now - this.startedAt < grace) continue;
        this.closeVanished(item, now);
        changed = true;
      }
      if (changed) await this.render(token, message);
    }
    this.deps.store.save();

    const afterMs = this.deps.store.settings.afterMinutes * 60_000;
    const ready = items.filter(
      (item) =>
        !this.deps.store.wasSent(item.key) &&
        (item.immediate || now - Date.parse(item.askedAt) >= afterMs),
    );
    if (ready.length === 0 || now < this.nextSendAt) return;
    const lastSentAt = this.deps.store.lastSentAt;
    if (lastSentAt && now - lastSentAt < (this.deps.coalesceMs ?? 60_000)) return;
    await this.send(token, ready.slice(0, this.deps.maxItems ?? 8));
  }

  private closeVanished(item: SentItem, now: number): void {
    const why = this.deps.vanished(item.target);
    item.state = 'done';
    delete item.missingSince;
    item.outcome =
      why.kind === 'inPanel'
        ? OUTCOME.inPanel(now)
        : why.kind === 'deferred'
          ? OUTCOME.deferred(why.id, now)
          : OUTCOME.stale(now);
  }

  private async send(token: string, items: PendingAskItem[]): Promise<void> {
    const ownerId = this.deps.store.settings.ownerId;
    const message: SentMessage = {
      sid: this.deps.store.nextSid(),
      chatId: ownerId,
      messageId: 0,
      nonce: newNonce(),
      sentAt: new Date(this.now()).toISOString(),
      items: items.map((item) => ({
        key: item.key,
        target: item.target,
        openId: item.openId,
        text: itemText(item),
        ...(item.questions?.length ? { questions: item.questions, step: 0, picks: [] } : {}),
        state: 'open' as const,
      })),
      actions: {},
      nextAction: 0,
    };
    await this.deliver(token, message);
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
    this.deps.store.add(message, this.now());
    return true;
  }

  /** Переписать сообщение по его состоянию; закрытое теряет кнопки. */
  private async render(token: string, message: SentMessage): Promise<void> {
    const open = message.items.some((item) => item.state === 'open');
    if (!open) message.closedAt ??= new Date(this.now()).toISOString();
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

  /** Разобрать одно обновление. Открыт для тестов. */
  async handleUpdate(update: BotUpdate): Promise<void> {
    const token = this.token;
    if (!token) return;
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
    const clientId = `tg-${message.sid}-${parsed.action}`;
    switch (action.act) {
      case 'allow':
      case 'deny':
        return this.finish(token, message, item, toast, clientId, {
          kind: 'decision',
          behavior: action.act,
        });
      case 'here':
      case 'stop':
        return this.finish(token, message, item, toast, clientId, {
          kind: 'branch',
          choice: action.act,
        });
      case 'pick':
      case 'toggle':
      case 'done':
        return this.pick(token, message, item, action, toast, clientId);
      case 'custom': {
        const prompt = await sendMessage(
          token,
          message.chatId,
          customPromptText(item),
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
    delete item.customPrompt;
    if (step + 1 < questions.length) {
      item.step = step + 1;
      await this.render(token, message);
      await toast(TOAST.next);
      return;
    }
    await this.finish(token, message, item, toast, clientId, {
      kind: 'questions',
      questions,
      picks: item.picks ?? [],
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
    const outcome = await this.deps.apply(item.target, answer, clientId);
    const now = this.now();
    if (outcome.ok) {
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
    this.deps.log(`telegram-answers: answer refused: ${outcome.detail}`);
    await toast(TOAST.failed);
  }

  /** Свой ответ — ответом (reply) на сообщение «напишите ответ». */
  private async handleReply(token: string, reply: BotMessage): Promise<void> {
    if (!this.isOwner(reply.chat.id, reply.from?.id)) {
      this.deps.log('telegram-answers: message from a non-owner ignored');
      return;
    }
    const to = reply.reply_to_message?.message_id;
    const text = reply.text?.trim();
    if (!to || !text) return;
    for (const message of this.deps.store.open()) {
      const index = message.items.findIndex(
        (item) => item.state === 'open' && item.customPrompt === to,
      );
      if (index < 0) continue;
      const item = message.items[index]!;
      const picks = (item.picks ??= []);
      picks[item.step ?? 0] = [text];
      const silent = () => Promise.resolve();
      await this.advance(token, message, item, silent, `tg-${message.sid}-r${reply.message_id}`);
      return;
    }
  }
}

function outcomeLine(answer: Answer, at: number): string {
  if (answer.kind === 'decision') {
    return answer.behavior === 'allow' ? OUTCOME.allowed(at) : OUTCOME.denied(at);
  }
  if (answer.kind === 'branch')
    return answer.choice === 'here' ? OUTCOME.here(at) : OUTCOME.stop(at);
  const text =
    answer.questions.length <= 1
      ? (answer.picks[0] ?? []).join(', ')
      : answer.picks.map((chosen) => chosen.join(', ')).join(' / ');
  return OUTCOME.answer(text, at);
}

function linksOf(message: SentMessage): string[] {
  return message.items.map((item) => panelLink(item.openId));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
