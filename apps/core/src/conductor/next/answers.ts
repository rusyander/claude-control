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
  /**
   * Точка 4 потерянного входа CLI (этап 12, P170, `conductor/human/login-ask.ts`): войти заново и
   * продолжить или остановить шаг; варианты перевода `model:`/`cli:` идут за ними.
   */
  login: {
    ru: { relogin: 'Я вошёл заново — продолжить', stop: 'Остановить шаг' },
    en: { relogin: 'I logged in again — continue', stop: 'Stop the step' },
  },
  /**
   * Пункт 9 комментария назад в тикет (этап 12, P166, `bootstrap/panel-trackers.ts`): разрешить
   * одну строку со ссылкой на MR или не писать. Отпускает запись только ответ панели или телефона.
   */
  trackerWrite: {
    ru: { approve: 'Разрешить комментарий', decline: 'Не писать' },
    en: { approve: 'Allow the comment', decline: 'Do not write' },
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

/** Переводы строки, на которых прежний разбор `/^(model|cli):(.+)$/` отказывал. */
const LINE_BREAKS = ['\n', '\r', '\u2028', '\u2029'];

/**
 * Ответ-переключение: `model:<id>` — правка модели задачи, `cli:<id>` — правка её CLI. Другой
 * текст, пустое значение или значение с переводом строки — `null`. Без регулярного выражения:
 * модули решений текст регулярками не разбирают (P32, `decision-regex.test.ts`).
 */
export function switchAnswerOf(
  answer: string | undefined,
): { field: 'model' | 'adapter'; value: string } | null {
  if (answer === undefined) return null;
  const colon = answer.indexOf(':');
  if (colon < 0) return null;
  const head = answer.slice(0, colon);
  const value = answer.slice(colon + 1);
  if (head !== 'model' && head !== 'cli') return null;
  if (!value || LINE_BREAKS.some((mark) => value.includes(mark))) return null;
  return { field: head === 'cli' ? 'adapter' : 'model', value };
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
  exhausted: (lang: AskLang, routeId: string, step: AskStep, offers = 0): string => {
    const title = stepTitleIn(step, lang);
    // Начатая задача (P169): другие годные маршруты есть, но уйти на них можно только кликом.
    if (offers > 0)
      return lang === 'en'
        ? `Route ${routeId} has used up its paid budget. Step ${EN_QUOTE(title)} of a started task ` +
            'stays on it until you choose: top up and clear the mark with the clear-exhausted ' +
            'command, move the task to another model or CLI below, or stop the step.'
        : `Маршрут ${routeId} исчерпал оплаченный бюджет. Шаг ${RU_QUOTE(title)} начатой задачи ` +
            'ждёт его, пока вы не выберете: пополнить счёт и снять отметку командой ' +
            'clear-exhausted, перевести задачу на другую модель или CLI ниже, или остановить шаг.';
    return lang === 'en'
      ? `Route ${routeId} has used up its paid budget, and step ${EN_QUOTE(title)} has no other ` +
          'allowed route. Top up the account and clear the mark with the clear-exhausted command, ' +
          'or stop the step.'
      : `Маршрут ${routeId} исчерпал оплаченный бюджет, другого разрешённого маршрута у шага ` +
          `${RU_QUOTE(title)} нет. Пополните счёт и снимите отметку командой clear-exhausted, или ` +
          'остановите шаг.';
  },
  /**
   * Точка 4 (P170): CLI маршрута потерял вход посреди шага — перечитанное состояние входа
   * «нет». Что модель успела сделать до отказа, неизвестно; сам шаг маршрут не меняет.
   */
  login: (lang: AskLang, routeId: string, step: AskStep, offers = 0): string => {
    const title = stepTitleIn(step, lang);
    const move =
      offers > 0
        ? lang === 'en'
          ? ', move the task to another model or CLI below'
          : ', перевести задачу на другую модель или CLI ниже'
        : '';
    return lang === 'en'
      ? `The CLI of route ${routeId} lost its login during step ${EN_QUOTE(title)}. Log in again ` +
          `in that CLI and continue${move}, or stop the step.`
      : `CLI маршрута ${routeId} потерял вход во время шага ${RU_QUOTE(title)}. Войдите в этот CLI ` +
          `заново и продолжите${move}, или остановите шаг.`;
  },
  /** Точка 4: сверка не узнала исход действия к сроку своего класса чтения. */
  reconcile: (lang: AskLang, kind: string, target: string, reason: string): string =>
    lang === 'en'
      ? `Could not find out whether action ${kind} → ${target} happened: ${reason}`
      : `Не удалось узнать, выполнено ли действие ${kind} → ${target}: ${reason}`,
} as const;
