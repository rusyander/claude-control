import type { BoardEntry, BoardMoveReply } from '@agentdeck/contracts/core/board';
import type { InboxCreateReply } from '@agentdeck/contracts/core/inbox';
import { offerCommand, offersOf } from '@agentdeck/contracts/core/window-offer';
import { parseCallback, verifyCallback } from '../telegram-answers/callback-data.ts';
import type { BotMessage } from '../telegram-answers/telegram-answers.types.ts';
import type {
  TelegramCommandPort,
  TelegramCoreOutcome,
} from '../telegram-core/command-port.types.ts';
import type { NoticeBot } from './bot.ts';
import { ACTION, LABEL, TEXT, entryText } from './compose.ts';
import type { NoticesCore } from './core-read.ts';
import { NO_REPOS_HINT, boardLinkLine, entryLaunchable, launchRefusedLine } from './launch.ts';
import type { NoticesEngine } from './notices.ts';
import type { NoticesStore } from './store.ts';
import type {
  NoticeContext,
  NoticeMessage,
  NoticePress,
  TelegramNoticesHooks,
} from './telegram-notices.types.ts';

/**
 * Что владелец делает с уведомлением: кнопки `n:`, ответ на подсказку «На доработку», `/task`.
 * Команды — только портом Telegram (заголовки канала владельца, P190); каждое действие несёт свой
 * ключ повтора (`<sid>:<действие>`, `tg:<чат>:<сообщение>`): повтор нажатия или то же сообщение
 * дважды — тот же `cmdId`, и ядро не исполняет его второй раз (P193). Отказ ядра (полномочия,
 * привязка) ничего не исполнил — ключ забывается, нажатие после привязки идёт с новым. Ядро не
 * ответило — ключ держится: если команда всё же дошла, повтор вернёт её же итог.
 */

export interface NoticeHooksDeps {
  store: NoticesStore;
  core: NoticesCore;
  port: TelegramCommandPort;
  bot: NoticeBot;
  engine: NoticesEngine;
  now: () => number;
  mintId: () => string;
}

const TASK_COMMAND = /^\/task(?:@\w+)?(?:\s+([\s\S]*))?$/i;
const TASK_TEXT_MAX = 4000;

type ShownMarkup = { inline_keyboard?: { text?: string; callback_data?: string }[][] };

export function createNoticeHooks(
  deps: NoticeHooksDeps,
): Omit<TelegramNoticesHooks, 'hold' | 'statusLines'> {
  const { store, engine } = deps;
  const titleOf = (taskId: string | undefined): string | null =>
    taskId ? (engine.titles.get(taskId) ?? null) : null;
  const launchableEntry = async (entryId: string): Promise<boolean> => {
    const entries = await deps.core.entries().catch(() => []);
    return entryLaunchable(entries.find((one) => one.entryId === entryId));
  };

  const run = async (
    key: string,
    call: (cmdId: string) => Promise<TelegramCoreOutcome>,
  ): Promise<TelegramCoreOutcome> => {
    const cmdId = store.cmdFor(key, deps.mintId);
    store.save(deps.now());
    const outcome = await call(cmdId);
    if (!outcome.ok && outcome.status !== 0) {
      store.forgetCmd(key);
      store.save(deps.now());
    }
    return outcome;
  };

  /** Отказ словами в чат (ответом на сообщение); тост — короткий. */
  const refusal = async (
    ctx: NoticeContext,
    outcome: Extract<TelegramCoreOutcome, { ok: false }>,
    replyTo: number,
  ): Promise<string> => {
    if (outcome.status === 0) return TEXT.unreachable;
    const words = outcome.reason ?? (outcome.message || outcome.code);
    const binding = outcome.status === 401 || outcome.status === 403;
    await deps.bot.send(
      ctx.token,
      ctx.origin.chatId,
      TEXT.refused(words, binding),
      undefined,
      replyTo,
    );
    return TEXT.refusedToast;
  };

  /** Нажатие честное: подпись, то самое сообщение, та же метка, что мы поставили. */
  const pressed = (ctx: NoticeContext, press: NoticePress) => {
    const parsed = parseCallback(press.data, 'n');
    if (!parsed) return undefined;
    const message = store.message(parsed.sid);
    if (
      !message ||
      message.closed ||
      message.chatId !== ctx.origin.chatId ||
      message.messageId !== press.message?.message_id ||
      !verifyCallback(store.secret, parsed, message.nonce, 'n')
    ) {
      return undefined;
    }
    const label = message.labels[parsed.action];
    if (!label) return undefined;
    // Метка под пальцем владельца — наша: подменённая подпись кнопки значит чужую правку.
    const shown = (press.message as { reply_markup?: ShownMarkup }).reply_markup;
    if (shown) {
      const button = shown.inline_keyboard?.flat().find((one) => one.callback_data === press.data);
      if (button?.text !== label) return undefined;
    }
    return { message, action: parsed.action, label };
  };

  const stop = async (ctx: NoticeContext, message: NoticeMessage): Promise<string> => {
    const taskId = message.taskId!;
    const view = await deps.core.view(taskId).catch(() => undefined);
    if (!view) return TEXT.unreachable;
    // Кончилась — «Стоп» не шлёт ничего (P191): правка сообщения и тост.
    if (view.ended !== null) {
      await engine.settle(message, TEXT.ended);
      return TEXT.ended;
    }
    const outcome = await run(`${message.sid}:${ACTION.stop}`, (cmdId) =>
      deps.port.command(ctx.origin, {
        kind: 'cancel',
        taskId,
        fields: { reason: TEXT.stopReason },
        cmdId,
      }),
    );
    if (!outcome.ok) return refusal(ctx, outcome, message.messageId);
    await engine.settle(message, TEXT.stopped);
    return TEXT.accepted;
  };

  const offer = async (
    ctx: NoticeContext,
    message: NoticeMessage,
    action: number,
    label: string,
  ): Promise<string> => {
    const taskId = message.taskId!;
    const option = message.offers?.[action - ACTION.offer];
    const view = await deps.core.view(taskId).catch(() => undefined);
    if (!view) return TEXT.unreachable;
    const live =
      view.state === 'waiting-window'
        ? offersOf(view).find((one) => one.option === option)
        : undefined;
    if (!live) {
      await engine.settle(message, TEXT.offersGone);
      return TEXT.offersGone;
    }
    // Ровно то, что шлёт карточка панели (P192): `set-cli` или `set-model` без усилия.
    const draft = offerCommand(taskId, live);
    const outcome = await run(`${message.sid}:${action}`, (cmdId) =>
      deps.port.command(ctx.origin, { ...draft, cmdId }),
    );
    if (!outcome.ok) return refusal(ctx, outcome, message.messageId);
    await engine.settle(message, TEXT.switched(label));
    return TEXT.accepted;
  };

  /** Отказ «В работу» до хода: русская строка под сообщением, ссылка на доску, кнопка остаётся. */
  const workRefused = async (message: NoticeMessage, line: string): Promise<string> => {
    await engine.settle(message, line, false, boardLinkLine());
    return TEXT.refusedToast;
  };

  /**
   * Какую запись запускает нажатие — заново с ЖИВОЙ доски ядра по ключу `tg:<чат>:<сообщение>`
   * того `/task`, на который ответило нажатое сообщение (номера даёт Telegram в самом нажатии), а не
   * по `entryId` из файла уведомлений: правка файла не должна запускать чужую запись (этап 12).
   */
  const workTarget = async (
    ctx: NoticeContext,
    press: NoticePress,
  ): Promise<{ entry: BoardEntry } | { line: string }> => {
    const asked = press.message?.reply_to_message?.message_id;
    let entries: BoardEntry[];
    try {
      entries = await deps.core.entries();
    } catch {
      return { line: launchRefusedLine({ code: 'board-unreadable' }) };
    }
    const tgKey = `tg:${ctx.origin.chatId}:${asked}`;
    const entry =
      asked === undefined
        ? undefined
        : entries.find((one) => one.source.kind === 'telegram' && one.source.key === tgKey);
    if (!entry) return { line: launchRefusedLine({ code: 'unknown-card' }) };
    if (!entryLaunchable(entry))
      return { line: launchRefusedLine({ reason: 'launch fields: repos' }) };
    return { entry };
  };

  const work = async (
    ctx: NoticeContext,
    message: NoticeMessage,
    press: NoticePress,
  ): Promise<string> => {
    const target = await workTarget(ctx, press);
    if ('line' in target) return workRefused(message, target.line);
    const { entryId } = target.entry;
    const key = `${message.sid}:${ACTION.work}`;
    // «В работу» = ход доски `work`; стартовать ли — решает запускатель ядра (P154).
    const outcome = await run(key, (cmdId) => deps.port.boardWork(ctx.origin, { cmdId, entryId }));
    if (!outcome.ok) {
      // Не ответило или не признало канал — прежний отказ (с подсказкой привязки, без прозы ядра).
      if (outcome.status === 0) return TEXT.unreachable;
      if (outcome.status === 401 || outcome.status === 403)
        return refusal(ctx, { ...outcome, reason: TEXT.notRecognised }, message.messageId);
      // Отказ хода — русской строкой по коду, незнакомый — общей строкой со ссылкой на доску.
      return workRefused(
        message,
        launchRefusedLine({ code: outcome.code, reason: outcome.reason ?? '' }),
      );
    }
    const entry = (outcome.body as BoardMoveReply).entries?.find((one) => one.entryId === entryId);
    if (entry?.state === 'started') {
      await engine.settle(message, TEXT.started(titleOf(entry.taskId)));
      return TEXT.accepted;
    }
    if (entry?.state === 'inbox' && entry.reason) {
      store.forgetCmd(key);
      await engine.settle(
        message,
        launchRefusedLine({ reason: entry.reason }),
        false,
        boardLinkLine(),
      );
      store.save(deps.now());
      return TEXT.accepted;
    }
    await engine.settle(message, TEXT.queued);
    store.file_.watch.push({ entryId, sid: message.sid, at: deps.now() });
    store.save(deps.now());
    return TEXT.accepted;
  };

  const rework = async (ctx: NoticeContext, message: NoticeMessage): Promise<string> => {
    const id = await deps.bot.prompt(
      ctx.token,
      ctx.origin.chatId,
      TEXT.reworkPrompt(titleOf(message.taskId)),
      TEXT.reworkPlaceholder,
      message.messageId,
    );
    if (id === undefined) return TEXT.unreachable;
    store.file_.prompts[String(id)] = { sid: message.sid, taskId: message.taskId!, at: deps.now() };
    store.save(deps.now());
    return TEXT.reworkAsk;
  };

  return {
    async press(ctx, press) {
      const hit = pressed(ctx, press);
      let toast: string = TEXT.stale;
      if (hit) {
        const { message, action, label } = hit;
        if (action === ACTION.rework) toast = await rework(ctx, message);
        else if (action === ACTION.stop) toast = await stop(ctx, message);
        else if (action === ACTION.work) toast = await work(ctx, message, press);
        else toast = await offer(ctx, message, action, label);
      }
      await deps.bot.toast(ctx.token, press.id, toast).catch(() => undefined);
      return true;
    },

    async reply(ctx, messages, to) {
      const first = messages[0];
      if (!first) return false;
      const prompt = store.file_.prompts[String(to)];
      if (prompt) {
        const text = messages.map((one) => (one.text ?? one.caption)?.trim()).find(Boolean);
        if (!text) {
          await deps.bot.send(
            ctx.token,
            ctx.origin.chatId,
            TEXT.reworkEmpty,
            undefined,
            first.message_id,
          );
          return true;
        }
        // Доработка конченной задачи — задача-носитель (P162): решает ядро, не мы.
        const outcome = await run(`tg:${ctx.origin.chatId}:${first.message_id}`, (cmdId) =>
          deps.port.command(ctx.origin, {
            kind: 'rework',
            taskId: prompt.taskId,
            fields: { text },
            cmdId,
          }),
        );
        if (outcome.ok) {
          const html = TEXT.reworkTaken(titleOf(prompt.taskId));
          await deps.bot.send(ctx.token, ctx.origin.chatId, html, undefined, first.message_id);
        } else if (outcome.status === 0) {
          await deps.bot.send(
            ctx.token,
            ctx.origin.chatId,
            TEXT.unreachable,
            undefined,
            first.message_id,
          );
        } else {
          await refusal(ctx, outcome, first.message_id);
        }
        return true;
      }
      const notice = store.messageById(to);
      if (notice && notice.chatId === ctx.origin.chatId) {
        await deps.bot.send(
          ctx.token,
          ctx.origin.chatId,
          TEXT.noticeHint,
          undefined,
          first.message_id,
        );
        return true;
      }
      return false;
    },

    async command(ctx, message: BotMessage) {
      const match = TASK_COMMAND.exec(message.text?.trim() ?? '');
      if (!match) return false;
      const text = (match[1] ?? '').trim().slice(0, TASK_TEXT_MAX);
      if (!text) {
        await deps.bot.send(
          ctx.token,
          ctx.origin.chatId,
          TEXT.taskUsage,
          undefined,
          message.message_id,
        );
        return true;
      }
      const key = `tg:${ctx.origin.chatId}:${message.message_id}`;
      // То же сообщение второй раз (повтор доставки) — ни второй записи, ни второго ответа.
      if (store.file_.entries[key]?.replied) return true;
      const outcome = await run(key, (cmdId) =>
        deps.port.inboxCreate(ctx.origin, { cmdId, text, key }),
      );
      if (!outcome.ok) {
        if (outcome.status === 0) {
          await deps.bot.send(
            ctx.token,
            ctx.origin.chatId,
            TEXT.unreachable,
            undefined,
            message.message_id,
          );
        } else {
          await refusal(ctx, outcome, message.message_id);
        }
        return true;
      }
      const reply = outcome.body as InboxCreateReply;
      const entryId = reply.created?.[0] ?? reply.existing?.[0];
      // «В работу» — только запускаемой записи (репозитории из настройки ядра в её полях); доска
      // не прочиталась — не доказано, кнопки нет: запускатель вернул бы запись с причиной.
      const launchable = entryId ? await launchableEntry(entryId) : false;
      const sent = await engine.post(
        {
          kind: 'entry',
          text: launchable
            ? entryText(text)
            : `${entryText(text)}\n${NO_REPOS_HINT}\n\n${boardLinkLine()}`,
          labels: launchable ? { [ACTION.work]: LABEL.work } : {},
          ...(entryId ? { entryId } : {}),
        },
        message.message_id,
      );
      store.file_.entries[key] = {
        ...(entryId ? { entryId } : {}),
        ...(sent ? { replied: sent.messageId } : {}),
        at: deps.now(),
      };
      store.save(deps.now());
      return true;
    },
  };
}
