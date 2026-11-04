/**
 * Вопросы человеку сценария `review-link@1` (этап 10, F8) — перенос карточки ревью старой панели:
 * «Починить в копии / Отписать в MR / И то и другое / Ничего не делать» и отдельный вопрос пуша
 * «Отправить в MR». Одна таблица на пресет (русские строки — данные пресета, неизменны: ими
 * записаны ответы в журналах), на перевод вопроса для задачи на английском и на ключ ответа,
 * который читает `next/review-link.ts`.
 */

export type ReviewAskLang = 'ru' | 'en';

export const REVIEW_DECIDE_STEP = 'decide';
export const REVIEW_PUSH_STEP = 'push';

export const REVIEW_DECIDE_ANSWERS = {
  ru: {
    fix: 'Починить в копии',
    post: 'Отписать в MR',
    both: 'И то и другое',
    none: 'Ничего не делать',
  },
  en: {
    fix: 'Fix in the copy',
    post: 'Post to the MR',
    both: 'Both',
    none: 'Do nothing',
  },
} as const;

export const REVIEW_PUSH_ANSWERS = {
  ru: { send: 'Отправить в MR', keep: 'Не отправлять' },
  en: { send: 'Send to the MR', keep: 'Do not send' },
} as const;

export type ReviewDecideKey = keyof (typeof REVIEW_DECIDE_ANSWERS)['ru'];
export type ReviewPushKey = keyof (typeof REVIEW_PUSH_ANSWERS)['ru'];

export interface ReviewAsk {
  question: string;
  options: string[];
  recommendation: string;
}

/**
 * Рекомендации — безопасные: писать в чужой MR и пушить в его ветку — решение человека, молчание
 * его не принимает (старая карточка тоже не делала ничего без щелчка).
 */
export const REVIEW_LINK_ASKS: Record<string, Record<ReviewAskLang, ReviewAsk>> = {
  [REVIEW_DECIDE_STEP]: {
    ru: {
      question: 'Ревью MR готово. Что сделать с замечаниями?',
      options: Object.values(REVIEW_DECIDE_ANSWERS.ru),
      recommendation: REVIEW_DECIDE_ANSWERS.ru.none,
    },
    en: {
      question: 'The MR review is done. What should happen with the findings?',
      options: Object.values(REVIEW_DECIDE_ANSWERS.en),
      recommendation: REVIEW_DECIDE_ANSWERS.en.none,
    },
  },
  [REVIEW_PUSH_STEP]: {
    ru: {
      question: 'Правки по ревью готовы в копии. Закоммитить и отправить их в ветку MR?',
      options: Object.values(REVIEW_PUSH_ANSWERS.ru),
      recommendation: REVIEW_PUSH_ANSWERS.ru.keep,
    },
    en: {
      question: 'The review fixes are ready in the copy. Commit and push them to the MR branch?',
      options: Object.values(REVIEW_PUSH_ANSWERS.en),
      recommendation: REVIEW_PUSH_ANSWERS.en.keep,
    },
  },
};

function keyIn<T extends Record<ReviewAskLang, Record<string, string>>>(
  tables: T,
  answer: string | undefined,
): keyof T['ru'] | undefined {
  if (answer === undefined) return undefined;
  for (const table of Object.values(tables)) {
    for (const [key, label] of Object.entries(table)) if (label === answer) return key;
  }
  return undefined;
}

/** Ключ ответа на вопрос решения по любому языку; чужой текст — `undefined`. */
export const decideKeyOf = (answer: string | undefined): ReviewDecideKey | undefined =>
  keyIn(REVIEW_DECIDE_ANSWERS, answer) as ReviewDecideKey | undefined;

/** Ключ ответа на вопрос пуша по любому языку; чужой текст — `undefined`. */
export const pushKeyOf = (answer: string | undefined): ReviewPushKey | undefined =>
  keyIn(REVIEW_PUSH_ANSWERS, answer) as ReviewPushKey | undefined;
