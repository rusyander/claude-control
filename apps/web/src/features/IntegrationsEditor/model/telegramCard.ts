import type { IntegrationStatus, TelegramEvent, TelegramSettings } from '@agentdeck/contracts';
import { TELEGRAM_DONE_AFTER_MINUTES, TELEGRAM_DONE_MAX_MINUTES } from '@agentdeck/contracts';
import type {
  TelegramAnswersSave,
  TelegramAnswersSettings,
  TelegramAnswersState,
  TelegramAnswersStatus,
} from '@agentdeck/contracts/telegram-answers';
import { TELEGRAM_EVENTS } from '@entities/Integration';
import type { TelegramCardDraft, TelegramGroups } from './telegramCard.types';

/**
 * Карточка Telegram (решение владельца 25.10.2026 после «мешанины»): вместо
 * шести технических галочек — три группы человеческими словами, одно
 * «Сохранить» на две настройки (уведомления и ответы) и одно слово о связи.
 *
 * Группы — над прежними списками событий, модель настроек не меняется: группа
 * отмечена, если отмечены все её события, а отметка ставит их все.
 */

/** «Агент ждёт тебя» — вопрос или разрешение. */
export const WAIT_EVENTS: readonly TelegramEvent[] = ['permission', 'question'];
/** «Что-то сломалось» — упал прогон или красные тесты. */
export const BROKEN_EVENTS: readonly TelegramEvent[] = ['runError', 'testFailed'];
/** «Бюджет контура» — в «Дополнительно». */
export const BUDGET_EVENTS: readonly TelegramEvent[] = ['budget'];

const GROUP_EVENTS: Record<keyof TelegramGroups, readonly TelegramEvent[]> = {
  waits: WAIT_EVENTS,
  broken: BROKEN_EVENTS,
  budget: BUDGET_EVENTS,
};

export function groupsOf(events: readonly TelegramEvent[]): TelegramGroups {
  const all = (list: readonly TelegramEvent[]) => list.every((event) => events.includes(event));
  return { waits: all(WAIT_EVENTS), broken: all(BROKEN_EVENTS), budget: all(BUDGET_EVENTS) };
}

/** Черновик из сохранённого: строки полей, флаги групп. */
export function draftOfTelegram(
  settings: TelegramSettings,
  answers: TelegramAnswersSettings | undefined,
): TelegramCardDraft {
  const done = settings.doneAfterMinutes ?? TELEGRAM_DONE_AFTER_MINUTES;
  return {
    chatId: settings.chatId,
    ownerId: answers?.ownerId ?? '',
    ...groupsOf(settings.events),
    afterMinutes: String(answers?.afterMinutes ?? 3),
    finished: done > 0,
    doneAfterMinutes: String(done > 0 ? done : TELEGRAM_DONE_AFTER_MINUTES),
    quietOn: Boolean(settings.quiet),
    quietFrom: settings.quiet?.from ?? QUIET_DEFAULT.from,
    quietTo: settings.quiet?.to ?? QUIET_DEFAULT.to,
    quietAsks: settings.quiet?.asks ?? false,
  };
}

/** Окно тишины, которое предлагается при первом включении: ночь. */
export const QUIET_DEFAULT = { from: '23:00', to: '08:00' } as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Окно тишины годится: оба края `ЧЧ:ММ` (как схема сервера) и не совпадают — у сервера
 * `from === to` значит «тишины нет», и включённая галочка молча ничего бы не делала.
 */
export function quietValid(draft: Pick<TelegramCardDraft, 'quietFrom' | 'quietTo'>): boolean {
  const from = draft.quietFrom.trim();
  const to = draft.quietTo.trim();
  return HHMM.test(from) && HHMM.test(to) && from !== to;
}

/** Целые минуты от 0 до суток. */
export function minutesValid(value: string): boolean {
  return /^\d{1,4}$/.test(value.trim()) && Number(value) <= TELEGRAM_DONE_MAX_MINUTES;
}

/** Настройка уведомлений из черновика. `runDone` у Telegram не читается и не пишется. */
export function notifyBody(draft: TelegramCardDraft, enabled: boolean): TelegramSettings {
  const events = TELEGRAM_EVENTS.filter((event) =>
    (Object.keys(GROUP_EVENTS) as (keyof TelegramGroups)[]).some(
      (group) => draft[group] && GROUP_EVENTS[group].includes(event),
    ),
  );
  return {
    enabled,
    chatId: draft.chatId.trim(),
    events,
    doneAfterMinutes: draft.finished ? Number(draft.doneAfterMinutes.trim()) : 0,
    // Тихие часы: выключены — поля нет (сервер читает «нет» как «тишины нет»).
    ...(draft.quietOn
      ? {
          quiet: {
            from: draft.quietFrom.trim(),
            to: draft.quietTo.trim(),
            asks: draft.quietAsks,
          },
        }
      : {}),
  };
}

/**
 * Настройка ответов из черновика: «Агент ждёт тебя» отмечено — зовём с кнопками
 * ответа всегда (решение владельца 25.10.2026: отдельная галочка кнопок лишняя).
 */
export function answersBody(draft: TelegramCardDraft): TelegramAnswersSave {
  return {
    enabled: draft.waits,
    afterMinutes: Number(draft.afterMinutes.trim()),
    ownerId: draft.ownerId.trim(),
  };
}

/** Подключено: токен бота сохранён и чат, куда писать, известен. */
export function isTelegramConnected(
  status: IntegrationStatus | undefined,
  settings: TelegramSettings,
): boolean {
  return Boolean(status?.hasToken) && settings.chatId.trim() !== '';
}

export type HealthReason =
  | { kind: 'check'; text: string }
  | { kind: 'send'; text: string }
  | { kind: 'answers'; state: TelegramAnswersState; detail?: string };

export type CardHealth =
  { tone: 'off' } | { tone: 'ok'; bot?: string } | { tone: 'error'; reason: HealthReason };

/** Опрос ответов в порядке или ещё не начинал — не беда. */
const ANSWERS_FINE: readonly TelegramAnswersState[] = ['off', 'polling'];

/**
 * Одно слово о связи: «работает · @бот» или «ошибка: …». Порядок причин — от
 * самой точной: отказ живой проверки, недоставленное уведомление, опрос ответов.
 */
export function cardHealth(input: {
  settings: TelegramSettings;
  status: IntegrationStatus | undefined;
  answers?: { settings: TelegramAnswersSettings; status: TelegramAnswersStatus };
}): CardHealth {
  if (!input.settings.enabled) return { tone: 'off' };
  const { status, answers } = input;
  if (status?.state === 'error') {
    return { tone: 'error', reason: { kind: 'check', text: status.detail } };
  }
  if (status?.lastSend && !status.lastSend.ok) {
    return { tone: 'error', reason: { kind: 'send', text: status.lastSend.error ?? '' } };
  }
  const polling = answers?.status;
  if (answers?.settings.enabled && polling) {
    const broken = !ANSWERS_FINE.includes(polling.state) || Boolean(polling.detail);
    if (broken) {
      return {
        tone: 'error',
        reason: {
          kind: 'answers',
          state: polling.state,
          ...(polling.detail ? { detail: polling.detail } : {}),
        },
      };
    }
  }
  const bot = status?.account ?? answers?.status.bot;
  return bot ? { tone: 'ok', bot } : { tone: 'ok' };
}

export type SaveResult = { ok: true } | { ok: false; failed: 'notify' | 'answers'; error: unknown };

/**
 * Одно «Сохранить» — два запроса подряд: уведомления, затем ответы. Упали
 * уведомления — ответы не трогаются (половина формы не уезжает молча); упали
 * ответы — уведомления уже сохранены, и человеку сказано именно это.
 */
export async function saveTelegramCard(api: {
  saveNotify: () => Promise<unknown>;
  saveAnswers: () => Promise<unknown>;
}): Promise<SaveResult> {
  try {
    await api.saveNotify();
  } catch (error) {
    return { ok: false, failed: 'notify', error };
  }
  try {
    await api.saveAnswers();
  } catch (error) {
    return { ok: false, failed: 'answers', error };
  }
  return { ok: true };
}
