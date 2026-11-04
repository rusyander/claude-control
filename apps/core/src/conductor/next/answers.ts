import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { stepTitleIn, titleLangOf } from '../scenario/titles.ts';
import { BUDGET_ANSWERS, EXHAUSTED_ANSWERS, ROUND_CAP_ANSWERS } from './next.types.ts';

/**
 * Вопросы дирижёра (точки 6 и 7) на языке задачи. Текст вопроса и подписи вариантов — на языке
 * панели, с которой задача запущена (`task.created.lang`); суд читает ответ по КЛЮЧУ варианта.
 * Ответ сверяется с подписями ВСЕХ языков: вопрос, поднятый до перевода (русские подписи), и
 * ответ, записанный тогда, после перезапуска ядра ведут к тому же действию у задачи любого языка.
 */

export type AskLang = 'ru' | 'en';

export const CONDUCTOR_ANSWERS = {
  roundCap: {
    ru: ROUND_CAP_ANSWERS,
    en: { more: 'One more round', stop: 'Stop the unit', cancel: 'Cancel the task' },
  },
  budget: {
    ru: BUDGET_ANSWERS,
    en: { more: 'Extend the limit', stop: 'Stop the step' },
  },
  exhausted: {
    ru: EXHAUSTED_ANSWERS,
    en: { wait: 'Wait for a top-up', stop: 'Stop the step' },
  },
  /**
   * Точка 4 сверки (`conductor/reconcile.ts`): исход действия не прочёлся. Русские строки — те,
   * которыми вопрос задавался до перевода; не менять: ими записаны ответы в старых журналах.
   */
  reconcile: {
    ru: {
      recheck: 'повторить сверку',
      done: 'считать выполненным',
      notDone: 'считать невыполненным',
    },
    en: { recheck: 'Check again', done: 'Treat as done', notDone: 'Treat as not done' },
  },
} as const;

export type AnswerFamily = keyof typeof CONDUCTOR_ANSWERS;
export type AnswerKey<F extends AnswerFamily> = keyof (typeof CONDUCTOR_ANSWERS)[F]['ru'];

/** Язык вопросов задачи: записанный при создании; нет (задача до этапа 10) — русский, как было. */
export const askLangOf = (state: TaskFoldState): AskLang => titleLangOf(state.created?.lang);

/** Подписи вариантов семьи на языке задачи — в порядке ключей. */
export function optionsOf<F extends AnswerFamily>(family: F, lang: AskLang): string[] {
  return Object.values(CONDUCTOR_ANSWERS[family][lang]);
}

/** Подпись одного варианта на языке задачи. */
export function labelOf<F extends AnswerFamily>(
  family: F,
  lang: AskLang,
  key: AnswerKey<F>,
): string {
  return (CONDUCTOR_ANSWERS[family][lang] as Record<AnswerKey<F>, string>)[key];
}

/** Ключ варианта по записанному ответу — среди подписей всех языков; чужой текст — `undefined`. */
export function answerKey<F extends AnswerFamily>(
  family: F,
  answer: string | undefined,
): AnswerKey<F> | undefined {
  if (answer === undefined) return undefined;
  for (const table of Object.values(CONDUCTOR_ANSWERS[family])) {
    for (const [key, label] of Object.entries(table)) {
      if (label === answer) return key as AnswerKey<F>;
    }
  }
  return undefined;
}

const RU_QUOTE = (t: string): string => `«${t}»`;
const EN_QUOTE = (t: string): string => `“${t}”`;

/** Шаг вопроса: заголовок пресета называется на языке задачи (`scenario/titles.ts`). */
type AskStep = Pick<StepDef, 'id' | 'title'>;

/** Тексты вопросов дирижёра по языку. */
export const CONDUCTOR_QUESTIONS = {
  roundCap: (lang: AskLang, step: AskStep, cap: number): string => {
    const title = stepTitleIn(step, lang);
    return lang === 'en'
      ? `Step ${EN_QUOTE(title)} used up its rounds (${cap}). What next?`
      : `Шаг ${RU_QUOTE(title)} исчерпал круги (${cap}). Что дальше?`;
  },
  budgetTime: (lang: AskLang, step: AskStep, minutes: number): string => {
    const title = stepTitleIn(step, lang);
    return lang === 'en'
      ? `Step ${EN_QUOTE(title)} ran over its time limit (${minutes} min). Extend it?`
      : `Шаг ${RU_QUOTE(title)} вышел за срок (${minutes} мин). Продлить?`;
  },
  budgetTokens: (lang: AskLang, step: AskStep, spent: number, limit: number): string => {
    const title = stepTitleIn(step, lang);
    return lang === 'en'
      ? `Step ${EN_QUOTE(title)} ran over its token budget (${spent} of ${limit}). Extend it?`
      : `Шаг ${RU_QUOTE(title)} вышел за бюджет токенов (${spent} из ${limit}). Продлить?`;
  },
  exhausted: (lang: AskLang, routeId: string, step: AskStep): string => {
    const title = stepTitleIn(step, lang);
    return lang === 'en'
      ? `Route ${routeId} has used up its paid budget, and step ${EN_QUOTE(title)} has no other ` +
          'allowed route. Top up the account and clear the mark with the clear-exhausted command, ' +
          'or stop the step.'
      : `Маршрут ${routeId} исчерпал оплаченный бюджет, другого разрешённого маршрута у шага ` +
          `${RU_QUOTE(title)} нет. Пополните счёт и снимите отметку командой clear-exhausted, или ` +
          'остановите шаг.';
  },
  /** Точка 4: сверка не узнала исход действия к сроку своего класса чтения. */
  reconcile: (lang: AskLang, kind: string, target: string, reason: string): string =>
    lang === 'en'
      ? `Could not find out whether action ${kind} → ${target} happened: ${reason}`
      : `Не удалось узнать, выполнено ли действие ${kind} → ${target}: ${reason}`,
} as const;
