import type { TelegramSettings } from '@agentdeck/contracts';
import { TELEGRAM_DONE_AFTER_MINUTES } from '@agentdeck/contracts/integrations';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { askHoldsOffers, offersOf } from '@agentdeck/contracts/core/window-offer';
import { newNonce, signCallback } from '../telegram-answers/callback-data.ts';
import type { PendingAskItem } from '../telegram-answers/telegram-answers.types.ts';
import type { TelegramCommandPort } from '../telegram-core/command-port.types.ts';
import type { NoticeBot, NoticeKeyboard } from './bot.ts';
import {
  ACTION,
  LABEL,
  TEXT,
  digestParts,
  doneText,
  failedText,
  failureReason,
  heldLine,
  mrButtonUrl,
  mrText,
  offerLabel,
  outcomeLine,
  statusLinesOf,
  windowText,
} from './compose.ts';
import type { NoticesCore } from './core-read.ts';
import { boardLinkLine, launchRefusedLine } from './launch.ts';
import { quietAt } from './quiet.ts';
import type { NoticesStore } from './store.ts';
import type { NoticeKind, NoticeMessage } from './telegram-notices.types.ts';

/**
 * Движок уведомлений о задачах ядра (этап 12, P191, P192, P194). Повод перечитать вид задачи —
 * строка потока пересылки (`onLine`, сгущённая по задаче) и проход по списку задач из сверки
 * сервиса ответов (`hold`, не чаще раза в 5 с). Одно уведомление на конец и вид: ключ
 * (`done:`/`failed:`/`mr:`/`window:`) пишется в файл только после ухода (или удержания тишиной) —
 * отказ Telegram после повторов 429 оставляет ключ свободным, и следующий проход шлёт снова.
 */

export interface NoticesEngineDeps {
  store: NoticesStore;
  core: NoticesCore;
  port: TelegramCommandPort;
  bot: NoticeBot;
  /** Токен бота ответов (отдельный или бот уведомлений). */
  token: () => string | undefined;
  /** Чат владельца — туда уходят уведомления (бот ответов пишет только ему). */
  ownerId: () => string;
  settings: () => TelegramSettings | undefined;
  /** Опрос ответов жив: без него кнопки некому разбирать — уведомлений нет. */
  covers: () => boolean;
  now: () => number;
  log: (message: string) => void;
  mintId: () => string;
  debounceMs?: number;
  pumpMs?: number;
}

/** Давний проход (или его не было): концы задач до него не сообщаются — без потока «вчерашнего». */
export const BASELINE_MS = 30 * 60_000;
const PUMP_MS = 5_000;
const DEBOUNCE_MS = 300;
const EVALUATE_MAX = 20;
const WATCH_MS = 6 * 60 * 60_000;

/** Неблокирующий вопрос: у него есть действие по умолчанию (P153) — тишина его держит. */
export function nonBlocking(item: PendingAskItem): boolean {
  const value = (item as { defaultAction?: unknown }).defaultAction;
  return typeof value === 'string' && value !== '';
}

/**
 * Ключи MR: единица задачи и сам MR по адресу. «На доработку» законченной задачи открывает
 * носителя (`openAnswerTask` ядра), и тот пишет ТОТ ЖЕ MR своей единице ещё в оценке — по одному
 * ключу единицы это был бы второй «MR открыт» о MR, уже объявленном (ревью telegram, 09.11).
 */
export function mrKeysOf(taskId: string, mr: { unitId: string; url: string }): string[] {
  return [`mr:${taskId}:${mr.unitId}`, `mr-url:${mr.url}`];
}

interface Plan {
  kind: Exclude<NoticeKind, 'entry'>;
  /** Ключи, которые закрывает это уведомление (конец + слитые с ним MR). */
  keys: string[];
  html: string;
  labels: Record<string, string>;
  url?: string;
  offers?: string[];
  windowSeq?: number;
}

export function createNoticesEngine(deps: NoticesEngineDeps) {
  const { store } = deps;
  const titles = new Map<string, string | null>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retry = new Set<string>();
  const running = new Set<string>();
  const again = new Set<string>();
  let pumping = false;
  let lastTick = Number.NEGATIVE_INFINITY;

  const titleOf = (taskId: string): string | null => titles.get(taskId) ?? null;

  /** Кнопки сообщения: ссылка MR первой строкой, действия одной строкой, варианты окна — по одной. */
  const keyboardOf = (message: NoticeMessage): NoticeKeyboard => {
    const rows: NoticeKeyboard = message.url ? [[{ text: LABEL.mr, url: message.url }]] : [];
    if (message.closed) return rows;
    const sign = (action: number) =>
      signCallback(store.secret, message.sid, action, message.nonce, 'n');
    const actions = Object.keys(message.labels)
      .map(Number)
      .sort((a, b) => a - b);
    const plain = actions.filter((n) => n < ACTION.offer);
    if (plain.length) {
      rows.push(plain.map((n) => ({ text: message.labels[n]!, callback_data: sign(n) })));
    }
    for (const n of actions.filter((one) => one >= ACTION.offer)) {
      rows.push([{ text: message.labels[n]!, callback_data: sign(n) }]);
    }
    return rows;
  };

  /** Отправить сообщение с кнопками `n:`; ушло — запись сообщения, нет — `undefined`. */
  const post = async (
    fields: Omit<NoticeMessage, 'sid' | 'nonce' | 'messageId' | 'chatId' | 'at'>,
    replyTo?: number,
  ): Promise<NoticeMessage | undefined> => {
    const token = deps.token();
    const chatId = deps.ownerId();
    if (!token || !chatId) return undefined;
    const message: NoticeMessage = {
      ...fields,
      sid: store.nextSid(),
      nonce: newNonce(),
      chatId,
      messageId: 0,
      at: deps.now(),
    };
    const id = await deps.bot.send(token, chatId, message.text, keyboardOf(message), replyTo);
    if (id === undefined) return undefined;
    message.messageId = id;
    store.addMessage(message);
    return message;
  };

  /**
   * Итог под сообщением: строка курсивом; `close` снимает кнопки `n:` (ссылка MR остаётся);
   * `tail` — готовая разметка после итога (ссылка на доску у отказа запуска).
   */
  const settle = async (
    message: NoticeMessage,
    line: string,
    close = true,
    tail?: string,
  ): Promise<void> => {
    const token = deps.token();
    if (!token) return;
    if (close) message.closed = true;
    const html = `${message.text}\n\n${outcomeLine(line)}${tail ? `\n${tail}` : ''}`;
    await deps.bot.edit(token, message.chatId, message.messageId, html, keyboardOf(message));
  };

  const doneOn = (settings: TelegramSettings | undefined): boolean =>
    (settings?.doneAfterMinutes ?? TELEGRAM_DONE_AFTER_MINUTES) !== 0;

  const windowPlan = (view: TaskView, taskId: string): Plan | undefined => {
    const wait = view.windowWait;
    if (view.state !== 'waiting-window' || !wait || view.ended !== null) return undefined;
    // Вопрос пункта 7 держит варианты (P192): карточку даёт он, вторая перебила бы его ответ.
    if (askHoldsOffers(view)) return undefined;
    const key = `window:${taskId}:${wait.seq}`;
    if (store.wasSent(key)) return undefined;
    const offers = offersOf(view);
    const labels: Record<string, string> = { [ACTION.stop]: LABEL.stop };
    offers.forEach((offer, i) => {
      labels[ACTION.offer + i] = offerLabel(offer);
    });
    return {
      kind: 'window',
      keys: [key],
      html: windowText(titleOf(taskId), taskId, wait, offers),
      labels,
      offers: offers.map((offer) => offer.option),
      windowSeq: wait.seq,
    };
  };

  /** Что сообщить по виду задачи; ключи, которые молчат по настройке, закрываются сразу. */
  const plansOf = (view: TaskView, taskId: string): Plan[] => {
    const settings = deps.settings();
    const title = titleOf(taskId);
    const plans: Plan[] = [];
    const fresh = (view.mrs ?? []).filter(
      (mr) => !mrKeysOf(taskId, mr).some((key) => store.wasSent(key)),
    );
    // MR, застанный уже слитым или закрытым, — не «готов к ревью»: ключ закрыт без сообщения.
    for (const mr of fresh.filter((one) => one.state !== 'opened')) {
      for (const key of mrKeysOf(taskId, mr)) store.markSent(key, deps.now());
    }
    let opened = fresh.filter((one) => one.state === 'opened');
    if (view.ended === 'done' && !store.wasSent(`done:${taskId}`)) {
      const keys = [`done:${taskId}`, ...opened.flatMap((mr) => mrKeysOf(taskId, mr))];
      if (doneOn(settings)) {
        // Конец и MR разом — одно сообщение с кнопкой MR, а не два (одно на конец).
        const url = opened.map((mr) => mrButtonUrl(mr.url)).find(Boolean);
        plans.push({
          kind: 'done',
          keys,
          html: doneText(title, taskId, opened),
          labels: { [ACTION.rework]: LABEL.rework },
          ...(url ? { url } : {}),
        });
      } else {
        for (const key of keys) store.markSent(key, deps.now());
      }
      opened = [];
    }
    if (view.ended === 'failed' && !store.wasSent(`failed:${taskId}`)) {
      if (settings?.events.includes('runError')) {
        const reason = failureReason(view);
        plans.push({
          kind: 'failed',
          keys: [`failed:${taskId}`],
          html: failedText(title, taskId, reason),
          labels: { [ACTION.rework]: LABEL.rework },
        });
      } else {
        store.markSent(`failed:${taskId}`, deps.now());
      }
    }
    for (const mr of opened) {
      const keys = mrKeysOf(taskId, mr);
      if (!doneOn(settings)) {
        for (const key of keys) store.markSent(key, deps.now());
        continue;
      }
      const url = mrButtonUrl(mr.url);
      plans.push({
        kind: 'mr',
        keys,
        html: mrText(title, taskId, mr),
        labels: {
          [ACTION.rework]: LABEL.rework,
          // «Стоп» — только пока задача не кончилась (P191).
          ...(view.ended === null ? { [ACTION.stop]: LABEL.stop } : {}),
        },
        ...(url ? { url } : {}),
      });
    }
    const window = windowPlan(view, taskId);
    if (window) plans.push(window);
    return plans;
  };

  /** Тишина (P194): уведомление ложится строкой сводки; ключ закрыт — второй раз не придёт. */
  const holdPlan = (plan: Plan, taskId: string): void => {
    store.file_.held.push({
      key: plan.keys[0]!,
      kind: plan.kind,
      taskId,
      line: heldLine(plan.kind, titleOf(taskId)),
      at: deps.now(),
      ...(plan.windowSeq !== undefined ? { windowSeq: plan.windowSeq } : {}),
    });
    for (const key of plan.keys) store.markSent(key, deps.now());
  };

  /** Отправить карточку по плану; ушла — ключи закрыты. */
  const sendPlan = async (plan: Plan, taskId: string): Promise<boolean> => {
    const sent = await post({
      kind: plan.kind,
      taskId,
      text: plan.html,
      labels: plan.labels,
      ...(plan.url ? { url: plan.url } : {}),
      ...(plan.offers ? { offers: plan.offers } : {}),
    });
    if (!sent) return false;
    for (const key of plan.keys) store.markSent(key, deps.now());
    return true;
  };

  const evaluateOnce = async (taskId: string): Promise<void> => {
    let view: TaskView;
    try {
      view = await deps.core.view(taskId);
    } catch (error) {
      retry.add(taskId);
      deps.log(`telegram-notices: view ${taskId}: ${String(error)}`);
      return;
    }
    const quiet = quietAt(deps.settings()?.quiet, deps.now());
    let failed = false;
    for (const plan of plansOf(view, taskId)) {
      if (quiet.inside) holdPlan(plan, taskId);
      else if (!(await sendPlan(plan, taskId))) {
        // Не ушло после повторов 429 — ключ свободен, задача в повтор следующего прохода.
        failed = true;
        break;
      }
    }
    if (failed) retry.add(taskId);
    else {
      retry.delete(taskId);
      if (view.ended !== null) store.markEnded(taskId);
    }
    store.save(deps.now());
  };

  /** Перечитать задачу; одна задача — один проход разом (второй повод — повтор после первого). */
  const evaluate = async (taskId: string): Promise<void> => {
    if (running.has(taskId)) {
      again.add(taskId);
      return;
    }
    running.add(taskId);
    try {
      do {
        again.delete(taskId);
        await evaluateOnce(taskId);
      } while (again.has(taskId));
    } finally {
      running.delete(taskId);
    }
  };

  /** Сводка в конце тишины; удержанная карточка окна — заново по живому виду, тот же шаг окна. */
  const digest = async (now: number): Promise<void> => {
    const held = store.file_.held;
    if (held.length === 0 || quietAt(deps.settings()?.quiet, now).inside) return;
    const token = deps.token();
    const chatId = deps.ownerId();
    if (!token || !chatId) return;
    const lines = held.filter((item) => item.kind !== 'window');
    if (lines.length) {
      for (const part of digestParts(lines.map((item) => item.line))) {
        const id = await deps.bot.send(token, chatId, part.text);
        if (id === undefined) return;
        const gone = new Set(lines.splice(0, part.count));
        store.file_.held = store.file_.held.filter((item) => !gone.has(item));
        store.save(now);
      }
    }
    for (const card of store.file_.held.filter((item) => item.kind === 'window')) {
      let view: TaskView;
      try {
        view = await deps.core.view(card.taskId);
      } catch {
        return;
      }
      const wait = view.windowWait;
      const live =
        view.state === 'waiting-window' && wait?.seq === card.windowSeq && !askHoldsOffers(view);
      if (live) {
        // Ключ закрывала тишина; карточка уходит сейчас — по тому же ключу, ровно один раз.
        delete store.file_.sent[card.key];
        const plan = windowPlan(view, card.taskId);
        if (plan && !(await sendPlan(plan, card.taskId))) {
          store.markSent(card.key, now);
          return;
        }
      }
      store.file_.held = store.file_.held.filter((item) => item !== card);
      store.save(now);
    }
  };

  /** Записи после «В работу»: стартовала — «Запущена», вернулась с причиной — причина (P154). */
  const watchEntries = async (now: number): Promise<void> => {
    const watch = store.file_.watch;
    if (watch.length === 0) return;
    const entries = await deps.core.entries();
    for (const item of [...watch]) {
      const entry = entries.find((one) => one.entryId === item.entryId);
      const message = store.message(item.sid);
      const drop = () => {
        store.file_.watch = store.file_.watch.filter((one) => one !== item);
      };
      if (!entry || !message) drop();
      else if (entry.state === 'started') {
        await settle(message, TEXT.started(entry.taskId ? titleOf(entry.taskId) : null)).then(drop);
      } else if (entry.state === 'rejected') {
        await settle(message, TEXT.rejected).then(drop);
      } else if (entry.state === 'inbox' && entry.reason) {
        // Вернулась во «Входящие» — кнопка снова жива, новое нажатие — новый ход.
        store.forgetCmd(`${message.sid}:${ACTION.work}`);
        await settle(
          message,
          launchRefusedLine({ reason: entry.reason }),
          false,
          boardLinkLine(),
        ).then(drop);
      } else if (now - item.at > WATCH_MS) drop();
    }
    store.save(now);
  };

  const pump = async (now: number): Promise<void> => {
    if (pumping || now - lastTick < (deps.pumpMs ?? PUMP_MS) || !deps.covers()) return;
    pumping = true;
    lastTick = now;
    try {
      const tasks = await deps.core.tasks();
      for (const task of tasks) titles.set(task.taskId, task.title);
      const last = store.file_.lastPumpAt;
      if (last === undefined || now - last > BASELINE_MS) {
        for (const task of tasks) if (task.ended !== null) store.markEnded(task.taskId);
      }
      const seen = store.file_.windowSeen;
      const queue = new Set(retry);
      for (const task of tasks) {
        if (task.ended !== null && !store.seenEnded(task.taskId)) queue.add(task.taskId);
        const moving = task.state === 'waiting-window' || task.state === 'publishing';
        if (moving && seen[task.taskId] !== task.seq) {
          seen[task.taskId] = task.seq;
          queue.add(task.taskId);
        }
        if (!moving) delete seen[task.taskId];
      }
      for (const taskId of [...queue].slice(0, EVALUATE_MAX)) await evaluate(taskId);
      await digest(now);
      await watchEntries(now);
      store.file_.lastPumpAt = now;
      store.save(now);
    } catch (error) {
      deps.log(`telegram-notices: pump: ${String(error)}`);
    } finally {
      pumping = false;
    }
  };

  return {
    titles,
    keyboardOf,
    post,
    settle,
    evaluate,
    pump,
    hold(items: readonly PendingAskItem[], now: number): readonly PendingAskItem[] {
      void pump(now);
      const quiet = deps.settings()?.quiet;
      if (!quietAt(quiet, now).inside) return items;
      // Блокирующий вопрос держится тишиной, только если владелец так решил (`asks`, P194).
      if (quiet?.asks) return [];
      return items.filter((item) => !nonBlocking(item));
    },
    async statusLines(): Promise<string[]> {
      return statusLinesOf(await deps.core.tasks());
    },
    onLine(task: { taskId: string; title: string | null }): void {
      titles.set(task.taskId, task.title);
      if (!deps.covers()) return;
      const known = timers.get(task.taskId);
      if (known) clearTimeout(known);
      const timer = setTimeout(() => {
        timers.delete(task.taskId);
        void evaluate(task.taskId).catch((error: unknown) =>
          deps.log(`telegram-notices: ${task.taskId}: ${String(error)}`),
        );
      }, deps.debounceMs ?? DEBOUNCE_MS);
      timer.unref?.();
      timers.set(task.taskId, timer);
    },
    stop(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type NoticesEngine = ReturnType<typeof createNoticesEngine>;
