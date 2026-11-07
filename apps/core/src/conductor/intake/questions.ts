import {
  classifyDedupe,
  INTAKE_ANSWERS,
  intakeDedupe,
  type IntakeAnswer,
  type IntakeCard,
} from '@agentdeck/contracts/core/intake';
import { TASK_CLASSES, type TaskClass } from '@agentdeck/contracts/core/lead';
import type { HumanPointRaise } from '../run/run.types.ts';
import { titleLangOf } from '../scenario/titles.ts';

/**
 * Вопросы приёма (W2-6, W2-8): ОДИН вопрос на карточку — каждая развилка со своей рекомендацией,
 * «подтвердить» принимает рекомендации, «остановить» кончает задачу; и вопрос класса, когда
 * `classify` в `lead.alwaysAsk`. Оба — пункт 10 (часть запуска), блокирующие, без шага: оценку
 * держит судья `next` (`next/lead-gate.ts`), пока вопрос открыт. Язык — панели запуска
 * (`task.created.lang`); ответ сверяется с подписями ВСЕХ языков.
 */

// Подписи и ключи вопросов — в контрактах: экран запуска группы шлёт те же подписи, ищет вопрос
// карточки по тому же ключу и называет задачи, ждущие ответа о классе.
export { classifyDedupe, INTAKE_ANSWERS, intakeDedupe, type IntakeAnswer };

const WORDS = {
  ru: {
    head: (goal: string) => `Карточка задачи: ${goal}.`,
    criteria: (n: number) => `Критериев приёмки: ${n}.`,
    fork: (i: number, q: string, rec: string, options: string[]) =>
      `${i}. ${q} Рекомендация: «${rec}» (варианты: ${options.join(' | ')}).`,
    tail: 'Подтвердить — принять рекомендации и продолжить.',
    klass: (cls: TaskClass, why: string) =>
      `Класс задачи по признакам — ${cls} (${why}). Подтвердите класс или выберите другой.`,
  },
  en: {
    head: (goal: string) => `Task card: ${goal}.`,
    criteria: (n: number) => `Acceptance criteria: ${n}.`,
    fork: (i: number, q: string, rec: string, options: string[]) =>
      `${i}. ${q} Recommended: “${rec}” (options: ${options.join(' | ')}).`,
    tail: 'Confirm accepts the recommendations and goes on.',
    klass: (cls: TaskClass, why: string) =>
      `Task class from the signals: ${cls} (${why}). Confirm the class or pick another.`,
  },
} as const;

/** Вопрос карточки: цель, число критериев и каждая развилка с рекомендацией. */
export function intakeAsk(taskId: string, card: IntakeCard, lang?: string): HumanPointRaise {
  const l = titleLangOf(lang);
  const w = WORDS[l];
  const forks = card.unknowns.map((u, i) => w.fork(i + 1, u.question, u.recommendation, u.options));
  return {
    source: 'intake',
    stepId: null,
    sessionId: null,
    action: null,
    point: 10,
    dedupe: intakeDedupe(taskId),
    question: [w.head(card.goal), w.criteria(card.acceptance.length), ...forks, w.tail].join('\n'),
    options: Object.values(INTAKE_ANSWERS[l]),
    recommendation: INTAKE_ANSWERS[l].confirm,
    blocking: true,
  };
}

/** Вопрос класса: варианты — классы, рекомендация — посчитанный ядром. */
export function classAsk(
  taskId: string,
  computed: TaskClass,
  why: string,
  lang?: string,
): HumanPointRaise {
  const w = WORDS[titleLangOf(lang)];
  return {
    source: 'intake',
    stepId: null,
    sessionId: null,
    action: null,
    point: 10,
    dedupe: classifyDedupe(taskId),
    question: w.klass(computed, why),
    options: [...TASK_CLASSES],
    recommendation: computed,
    blocking: true,
  };
}

/** Ключ ответа на вопрос карточки — по подписям всех языков; чужой текст — `undefined`. */
export function intakeAnswerOf(answer: string): IntakeAnswer | undefined {
  for (const table of Object.values(INTAKE_ANSWERS))
    for (const [key, label] of Object.entries(table))
      if (label === answer) return key as IntakeAnswer;
  return undefined;
}

/**
 * Вопрос ведущего и годный ли ответ: `null` — вопрос не ведущего; `false` — ответ вне вариантов
 * (вопрос остался бы закрытым, а оценка ждала бы вечно — команда его отказывает).
 */
export function leadAnswerFits(
  taskId: string,
  dedupe: string | null,
  answer: string,
): boolean | null {
  if (dedupe === intakeDedupe(taskId)) return intakeAnswerOf(answer) !== undefined;
  if (dedupe === classifyDedupe(taskId)) return classAnswerOf(answer) !== undefined;
  return null;
}

/** Класс из ответа человека; не класс — `undefined`. */
export function classAnswerOf(answer: string): TaskClass | undefined {
  return TASK_CLASSES.find((c) => c === answer.trim());
}
