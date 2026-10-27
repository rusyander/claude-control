import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  TelegramConnectCandidate,
  TelegramConnectReason,
  TelegramConnectView,
} from '@agentdeck/contracts/telegram-answers';
import { botIdOf, getMe, getUpdates, getWebhookInfo } from './bot-api.ts';
import { sleep } from './sleep.ts';
import type { BotUpdate } from './telegram-answers.types.ts';

/**
 * Подключение бота командой /start: окно на пять минут, в которое человек
 * нажимает «Start» в личном чате с ботом, а панель узнаёт его id.
 *
 * Пришедший `/start` — только КАНДИДАТ. В настройки id ложится после
 * подтверждения «это я» в панели (маршрут только для человека): бот публичен,
 * и написать ему `/start` может кто угодно. Поэтому же принимается лишь
 * личный чат, лишь пока окно открыто и лишь `/start <код>` с кодом этого окна:
 * ссылка `t.me/<бот>?start=<код>` есть только у того, кто смотрит на карточку.
 * Чужой `/start` без кода или с другим кодом окно не занимает — человек со
 * ссылкой не проиграет гонку постороннему. `/start`, пришедший до открытия, не
 * считается.
 *
 * Слушатель у токена один (иначе Telegram отвечает 409 обоим). Если этот бот
 * уже слушает опрос ответов, `/start` разбирает он и отдаёт сюда (`offer`); окно
 * своего опроса не заводит. Иначе окно опрашивает бота само, пока открыто, и
 * перед каждым запросом проверяет, не начал ли опрос ответов.
 */

export interface ConnectDeps {
  /** Токен бота карточки Telegram. */
  token: () => string | undefined;
  /** Номера ботов, которых слушает агент (`same-bot.ts`). */
  agentBotIds: () => Set<string>;
  /** Слушает ли этот токен опрос ответов прямо сейчас. */
  serviceListens: (token: string) => boolean;
  log: (message: string) => void;
  now?: () => number;
  windowMs?: number;
  pollSeconds?: number;
  /** Пауза, пока токен слушает опрос ответов, и после сбоя сети. */
  idleMs?: number;
}

const WINDOW_MS = 5 * 60_000;
/** `/start`, отправленный чуть раньше открытия (часы машины и Telegram), ещё свой. */
const CLOCK_SLACK_MS = 5_000;

/** `/start <код>`: код deep link Telegram — до 64 знаков `A-Za-z0-9_-`. */
const START = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})$/;

/** Код окна: 96 бит случайности, новый на каждое открытие. */
function newWindowCode(): string {
  return randomBytes(12).toString('base64url');
}

function sameCode(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ConnectWindow {
  private readonly deps: ConnectDeps;
  private readonly now: () => number;
  private view: TelegramConnectView = { state: 'idle' };
  private openedAt = 0;
  private expiresAt = 0;
  private code = '';
  private generation = 0;
  private abort: AbortController | undefined;

  constructor(deps: ConnectDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Состояние для карточки; истёкшее окно закрывается при чтении. */
  status(): TelegramConnectView {
    if (this.view.state === 'waiting' && this.now() >= this.expiresAt) this.expire();
    return { ...this.view };
  }

  private fail(reason: TelegramConnectReason, detail?: string): TelegramConnectView {
    this.stopPolling();
    this.view = { state: 'failed', reason, ...(detail ? { detail } : {}) };
    return this.status();
  }

  private expire(): void {
    this.stopPolling();
    const { bot, link } = this.view;
    this.view = { state: 'expired', ...(bot ? { bot } : {}), ...(link ? { link } : {}) };
  }

  private stopPolling(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
  }

  /** Открыть окно (заново — с начала). */
  async open(): Promise<TelegramConnectView> {
    this.stopPolling();
    const generation = this.generation;
    const token = this.deps.token();
    const botId = botIdOf(token);
    if (!token || !botId) return this.fail('no-token');
    if (this.deps.agentBotIds().has(botId)) return this.fail('same-bot');
    const me = await getMe(token);
    if (generation !== this.generation) return this.status();
    if (!me.ok) {
      return this.fail(
        me.status === 401 || me.status === 404 ? 'unauthorized' : 'network',
        me.description,
      );
    }
    const bot = me.result.username;
    // Бот без имени: ссылку t.me не собрать, а это и есть вход окна.
    if (!bot) return this.fail('unauthorized');
    const own = !this.deps.serviceListens(token);
    let offset = 0;
    if (own) {
      const hook = await getWebhookInfo(token);
      if (hook.ok && hook.result.url) return this.fail('webhook');
      // Всё, что пришло до окна, подтверждается и не читается: старый `/start`
      // чужого человека кандидатом не станет.
      const last = await getUpdates(token, -1, 0);
      if (!last.ok) {
        return this.fail(last.status === 409 ? 'conflict' : 'network', last.description);
      }
      const latest = last.result?.at(-1)?.update_id;
      offset = latest === undefined ? 0 : latest + 1;
    }
    if (generation !== this.generation) return this.status();
    this.openedAt = this.now();
    this.expiresAt = this.openedAt + (this.deps.windowMs ?? WINDOW_MS);
    this.code = newWindowCode();
    this.view = {
      state: 'waiting',
      bot,
      link: `https://t.me/${bot}?start=${this.code}`,
      expiresAt: new Date(this.expiresAt).toISOString(),
    };
    this.abort = new AbortController();
    void this.pollLoop(generation, token, offset, this.abort.signal);
    return this.status();
  }

  /** Закрыть окно без записи. */
  cancel(): TelegramConnectView {
    this.stopPolling();
    this.view = { state: 'idle' };
    return this.status();
  }

  /** Забрать кандидата для подтверждения; нет его или окно истекло — ничего. */
  take(): TelegramConnectCandidate | undefined {
    const view = this.status();
    return view.state === 'candidate' ? view.candidate : undefined;
  }

  /** Подтверждено и записано маршрутом. */
  confirmed(candidate: TelegramConnectCandidate): TelegramConnectView {
    this.stopPolling();
    const { bot, link } = this.view;
    this.view = {
      state: 'confirmed',
      candidate,
      ...(bot ? { bot } : {}),
      ...(link ? { link } : {}),
    };
    return this.status();
  }

  /**
   * Обновление бота — `/start` в окно? `true` — забрано окном: опрос ответов
   * его дальше не разбирает. Зовут и свой опрос окна, и опрос ответов.
   */
  offer(update: BotUpdate): boolean {
    const message = update.message;
    if (!message || this.status().state !== 'waiting') return false;
    const code = START.exec(message.text?.trim() ?? '')?.[1];
    if (message.chat.type !== 'private' || !code || !this.code || !sameCode(code, this.code)) {
      return false;
    }
    if (message.date && message.date * 1000 < this.openedAt - CLOCK_SLACK_MS) return false;
    const from = message.from;
    if (!from || from.is_bot || from.id !== message.chat.id) return false;
    this.view = {
      ...this.view,
      state: 'candidate',
      candidate: {
        id: String(from.id),
        firstName: from.first_name ?? '',
        ...(from.username ? { username: from.username } : {}),
      },
    };
    this.deps.log('telegram connect: /start received, waiting for confirmation in the panel');
    return true;
  }

  private async pollLoop(
    generation: number,
    token: string,
    start: number,
    signal: AbortSignal,
  ): Promise<void> {
    let offset = start;
    const idle = this.deps.idleMs ?? 1_000;
    const live = () => generation === this.generation && !signal.aborted;
    while (live() && this.status().state === 'waiting') {
      if (this.deps.serviceListens(token)) {
        await sleep(idle, signal);
        continue;
      }
      const left = Math.ceil((this.expiresAt - this.now()) / 1000);
      const seconds = Math.max(0, Math.min(this.deps.pollSeconds ?? 25, left));
      const updates = await getUpdates(token, offset, seconds, signal);
      if (!live()) return;
      if (!updates.ok) {
        // Опрос ответов занял бота посреди нашего запроса — дальше он отдаёт
        // `/start` сам; это не конфликт.
        if (updates.status === 409 && this.deps.serviceListens(token)) continue;
        if (updates.status === 409) return void this.fail('conflict', updates.description);
        if (updates.status === 401 || updates.status === 404) {
          return void this.fail('unauthorized', updates.description);
        }
        await sleep(idle * 3, signal);
        continue;
      }
      for (const update of updates.result ?? []) {
        offset = Math.max(offset, update.update_id + 1);
        this.offer(update);
      }
    }
    // Разобранное подтверждается: иначе тот же `/start` пришёл бы потом опросу
    // ответов ещё раз.
    if (offset > start && !this.deps.serviceListens(token)) await getUpdates(token, offset, 0);
  }
}
