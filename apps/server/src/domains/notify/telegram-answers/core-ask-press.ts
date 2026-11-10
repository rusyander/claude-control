import {
  commandsFor,
  type AskCardAsk,
  type AskChoice,
} from '@agentdeck/contracts/core/ask-commands';
import type { AskView } from '@agentdeck/contracts/core/task-view';
import type { TelegramCommandPort, TelegramOrigin } from '../telegram-core/command-port.types.ts';
import type { Answer } from './apply.ts';
import { labelOf, visibleOptions, type CoreAsks } from './core-asks.ts';
import type { ApplyOutcome, BotUpdate, CoreAskTarget } from './telegram-answers.types.ts';

/**
 * Нажатие на вопрос ядра (этап 12, D29, P188, P189): выбор → те же команды, что у карточки панели
 * (`contracts/core/ask-commands`), порт команд Telegram → ядро. Пункт 5 «Разрешить этот вызов» —
 * `answer grant`, без `grant`: право шире вопроса из Telegram не выдаётся (P187).
 *
 * Честность нажатия: команда уходит, только если показанное совпало с живым — подпись кнопки, как
 * её показал Telegram, равна подписи из файла ответов, вопрос в сообщении и в файле равен живому
 * вопросу ядра, выбранный вариант есть среди живых. Иначе ничего не отправлено и приходит свежая
 * копия: правка сообщения или файла ответов не превращает «Отказать» в «Разрешить».
 */

/** Отказы ядра, означающие «этот чат ядру не владелец» — нужна новая привязка, не другой ответ. */
const NOT_OWNER = new Set(['signature-required', 'untrusted-forward', 'nonce-invalid']);

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Карточный вид вопроса для `commandsFor`: деление — из ключа `split:<id>`. */
function cardAskOf(ask: AskView): AskCardAsk {
  const split = ask.dedupe?.startsWith('split:') ? ask.dedupe.slice('split:'.length) : null;
  return {
    askId: ask.askId,
    point: ask.point,
    source: ask.source,
    question: ask.question ?? '',
    options: ask.options ?? [],
    defaultAction: ask.defaultAction ?? null,
    splitId: split,
    permit: null,
    repoKey: null,
  };
}

/**
 * Показанное Telegram совпало с тем, что бот показал бы сейчас: текст нажатой кнопки равен
 * `expectedButton` (подпись из файла ответов), в тексте сообщения есть вопрос из файла ответов.
 */
export function coreAskPressIntact(
  target: CoreAskTarget,
  press: NonNullable<BotUpdate['callback_query']>,
  expectedButton: string | undefined,
): boolean {
  const shown = press.message?.reply_markup?.inline_keyboard
    ?.flat()
    .find((button) => button.callback_data === press.data)?.text;
  if (shown === undefined || expectedButton === undefined || shown !== expectedButton) {
    return false;
  }
  return questionShown(target, press.message?.text);
}

/**
 * Вопрос из файла ответов есть в тексте сообщения, каким его видит Telegram. Тот же суд — у ответа
 * своим текстом на сообщение вопроса (`reply_to_message`): правка сообщения токеном бота не
 * подставит человеку другой вопрос (D29, critic B2).
 */
export function questionShown(target: CoreAskTarget, shownText: string | undefined): boolean {
  const head = flat(target.question).slice(0, 40);
  return head === '' || flat(shownText ?? '').includes(head);
}

export interface CoreAskApplyDeps {
  asks: CoreAsks;
  port: TelegramCommandPort;
  /** Обновление-источник: отпечаток владельца считает порт. */
  origin: () => TelegramOrigin | null;
}

/** Выбор человека → вариант живого вопроса или свой текст; `null` — не совпал с живым. */
function choiceOf(
  target: CoreAskTarget,
  live: AskView,
  picked: string,
): { choice: AskChoice; slot: number } | null {
  const options = visibleOptions(live);
  const at = options.findIndex((option) => labelOf(option) === picked);
  if (at >= 0) {
    return {
      choice: { type: 'option', option: options[at] ?? '', cancelReason: 'Отменено из Telegram' },
      slot: at,
    };
  }
  if (target.freeText && picked.trim()) {
    return { choice: { type: 'text', text: picked }, slot: options.length };
  }
  return null;
}

export async function applyCoreAsk(
  target: CoreAskTarget,
  answer: Answer,
  deps: CoreAskApplyDeps,
): Promise<ApplyOutcome> {
  if (answer.kind !== 'questions') return { ok: false, detail: 'не то решение' };
  const origin = deps.origin();
  if (!origin) return { ok: false, detail: 'бот ответов не настроен', rebind: true };
  let live: AskView | null;
  try {
    live = await deps.asks.live(target);
  } catch (error) {
    return { ok: false, detail: `ядро не ответило: ${String(error)}` };
  }
  if (!live || live.state !== 'open') return { ok: false, gone: true };
  const picked = answer.picks[0]?.[0] ?? '';
  const chosen =
    flat(live.question ?? '') === flat(target.question) ? choiceOf(target, live, picked) : null;
  if (!chosen) return { ok: false, detail: 'показанное разошлось с живым вопросом', changed: true };
  const drafts = commandsFor(target.taskId, cardAskOf(live), chosen.choice);
  if (!drafts || drafts.length !== 1) {
    return { ok: false, detail: 'у выбора нет команды из Telegram', coreOnly: true };
  }
  const [draft] = drafts;
  const cmdId = target.cmdIds[chosen.slot];
  if (!draft || !cmdId) return { ok: false, detail: 'нет ключа повтора', changed: true };
  const outcome = await deps.port.command(origin, { ...draft, cmdId });
  if (outcome.ok) return { ok: true };
  if (outcome.code === 'core-unreachable') return { ok: false, detail: outcome.message };
  // Ядро записало отказ под этим ключом: следующее нажатие — новым ключом, иначе повтор
  // отдал бы тот же отказ и после новой привязки.
  deps.asks.remint(target, chosen.slot);
  if (NOT_OWNER.has(outcome.code)) {
    return { ok: false, detail: `${outcome.code}: ${outcome.message}`, rebind: true };
  }
  if (outcome.code === 'telegram-binding') {
    return { ok: false, detail: outcome.reason ?? outcome.message, coreOnly: true };
  }
  return { ok: false, detail: `${outcome.code}: ${outcome.message}` };
}
