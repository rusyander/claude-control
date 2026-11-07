import type { PresetId, Scenario, StepDef } from '@agentdeck/contracts/core/scenario';
import { isPresetId } from './presets.ts';
import { REVIEW_LINK_ASKS } from './review-link-asks.ts';

/**
 * Заголовки пресетов и их шагов на языке человека. Данные пресетов (`presets.ts`) — русские и
 * неизменны: это значения, под которыми пресет живёт в коде и в старых журналах. Здесь — таблица
 * по id: панель и вопросы дирижёра показывают заголовок на языке панели (запуска задачи), а не
 * русскую строку данных. Заменяется только нетронутый заголовок пресета (совпал с русской строкой
 * таблицы); свой заголовок человека или старое значение, которого в таблице нет, остаётся как
 * записан — сценарий старой задачи читается всегда.
 */

export type TitleLang = 'ru' | 'en';

export interface TitlePair {
  ru: string;
  en: string;
}

/** Язык из того, что прислали (тело, запрос, `task.created.lang`): чужое и пустое — русский. */
export const titleLangOf = (raw: unknown): TitleLang => (raw === 'en' ? 'en' : 'ru');

/** Заголовки пресетов по id; русские равны данным пресета (сверяет `titles.test.ts`). */
export const PRESET_TITLES: Record<PresetId, TitlePair> = {
  'bug-fix': { ru: 'Исправление ошибки', en: 'Bug fix' },
  feature: { ru: 'Новая возможность', en: 'New feature' },
  refactor: { ru: 'Рефакторинг', en: 'Refactoring' },
  'review-only': { ru: 'Только ревью', en: 'Review only' },
  'tracker-ticket': { ru: 'Задача из трекера', en: 'Tracker ticket' },
  'answer-reviewers': { ru: 'Ответы ревьюерам', en: 'Reviewer replies' },
  chat: { ru: 'Чат', en: 'Chat' },
  ask: { ru: 'Вопрос модели', en: 'Model question' },
  'review-link': { ru: 'Ревью MR по ссылке', en: 'MR review by link' },
  lead: { ru: 'Ведущий', en: 'Lead' },
};

/**
 * Заголовки шагов пресетов по id шага: id шага у пресетов один на один заголовок (сверяет
 * `titles.test.ts`). Те же строки называют стадии конвейера при переносе «Пути» (`from-path.ts`).
 */
export const STEP_TITLES: Record<string, TitlePair> = {
  intake: { ru: 'Разбор запроса', en: 'Intake' },
  recon: { ru: 'Разведка', en: 'Recon' },
  plan: { ru: 'План', en: 'Plan' },
  work: { ru: 'Работа', en: 'Work' },
  review: { ru: 'Ревью', en: 'Review' },
  fix: { ru: 'Правки по ревью', en: 'Review fixes' },
  'final-gate': { ru: 'Финальная проверка', en: 'Final check' },
  'integration-gate': { ru: 'Проверка интеграции', en: 'Integration check' },
  'integration-review': { ru: 'Ревью интеграции', en: 'Integration review' },
  publish: { ru: 'Публикация', en: 'Publish' },
  'answer-reviewers': { ru: 'Ответы ревьюерам', en: 'Reviewer replies' },
  report: { ru: 'Отчёт', en: 'Report' },
  'tracker-status': { ru: 'Статус в трекере', en: 'Tracker status' },
  chat: { ru: 'Чат', en: 'Chat' },
  ask: { ru: 'Ответ', en: 'Answer' },
  decide: { ru: 'Решение по замечаниям', en: 'Decision on findings' },
  push: { ru: 'Отправка в MR', en: 'Send to the MR' },
};

/**
 * Вопрос шага `ask-human` пресета на языке задачи (этап 10, F8): заменяется только нетронутый
 * вопрос пресета (совпал с русской стороной таблицы); вопрос человека из библиотеки — как записан.
 */
export function stepAskIn(
  def: Pick<StepDef, 'id' | 'ask'>,
  lang: TitleLang,
): NonNullable<StepDef['ask']> | undefined {
  const ask = def.ask;
  if (!ask) return undefined;
  const pair = Object.hasOwn(REVIEW_LINK_ASKS, def.id) ? REVIEW_LINK_ASKS[def.id] : undefined;
  if (!pair || ask.question !== pair.ru.question) return ask;
  return pair[lang];
}

/** Заголовок, известный таблице на любом языке, — на нужном; иначе — как записан. */
function pick(pair: TitlePair | undefined, stored: string, lang: TitleLang): string {
  if (!pair) return stored;
  return stored === pair.ru || stored === pair.en ? pair[lang] : stored;
}

/** Заголовок шага на языке человека: шаг пресета — по таблице, свой заголовок — как записан. */
export function stepTitleIn(def: Pick<StepDef, 'id' | 'title'>, lang: TitleLang): string {
  return pick(
    Object.hasOwn(STEP_TITLES, def.id) ? STEP_TITLES[def.id] : undefined,
    def.title,
    lang,
  );
}

/** Заголовок сценария на языке человека: пресет — по таблице, сценарий библиотеки — как записан. */
export function scenarioTitleIn(s: Pick<Scenario, 'id' | 'title'>, lang: TitleLang): string {
  return pick(isPresetId(s.id) ? PRESET_TITLES[s.id] : undefined, s.title, lang);
}

/**
 * Пресет для показа на языке человека: заголовок и заголовки шагов. Сценарий библиотеки — текст
 * человека, он не переводится (правка в редакторе сохранила бы чужие слова новой версией).
 */
export function localizePreset(s: Scenario, lang: TitleLang): Scenario {
  if (!isPresetId(s.id)) return s;
  return {
    ...s,
    title: scenarioTitleIn(s, lang),
    steps: s.steps.map((step) => {
      const ask = stepAskIn(step, lang);
      return { ...step, title: stepTitleIn(step, lang), ...(ask ? { ask } : {}) };
    }),
  };
}
