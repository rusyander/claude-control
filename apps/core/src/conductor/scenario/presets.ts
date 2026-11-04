import {
  ROUND_CAP_DEFAULT,
  STEP_TIER_OF,
  type Gate,
  type PresetId,
  type Scenario,
  type ScenarioRef,
  type StepDef,
  type StepKind,
} from '@agentdeck/contracts/core/scenario';
import { REVIEW_DECIDE_STEP, REVIEW_LINK_ASKS, REVIEW_PUSH_STEP } from './review-link-asks.ts';

/**
 * Семь готовых сценариев (02 §Scenario; шестой — ответы ревьюерам, его открывает опрос форжа,
 * седьмой — чат панели, этап 10) — в коде и с версией: правка пресета — новая версия
 * здесь же, а не перезапись старой, иначе задача, начатая на `bug-fix@1`, после выпуска ядра
 * читала бы другой сценарий под той же ссылкой. Библиотека человека (`<дом ядра>/scenarios/`)
 * id пресетов не занимает: они зарезервированы за кодом.
 */

interface StepExtra {
  gate?: Gate[];
  text?: string;
}

/** Шаг пресета: каждое поле схемы названо (P42), значения — канон 02 (круги 2, «спросить»). */
export function presetStep(
  id: string,
  kind: StepKind,
  title: string,
  after: string[],
  extra: StepExtra = {},
): StepDef {
  return {
    id,
    kind,
    title,
    after,
    knowledge: {
      skills: [],
      rules: [],
      hooks: [],
      scripts: [],
      ...(extra.text ? { text: extra.text } : {}),
    },
    // Уровень по виду шага — таблица контрактов, одна на ядро и редактор сценария панели.
    model: { tier: STEP_TIER_OF[kind] },
    checks: { mid: 'narrow', required: [] },
    roundCap: ROUND_CAP_DEFAULT,
    budget: {},
    overBudget: 'ask',
    userLayer: { hooks: 'on', skills: 'on' },
    gate: extra.gate ?? [],
  };
}

const COVERED: Gate = { kind: 'requirements-covered' };
const NO_BLOCKING: Gate = { kind: 'review-no-blocking' };
const RED_BEFORE: Gate = { kind: 'regression-red-before' };
/** Рефакторинг: поведение то же — тот же набор тестов зелёный до и после (02:19). */
const EQUIVALENT: Gate = {
  kind: 'text',
  criterion:
    'Behaviour is unchanged: the same test set is green before and after the change, none removed or skipped.',
};

/** Хвост доставки: финальные ворота → публикация → ответ ревьюерам. */
function delivery(after: string): StepDef[] {
  return [
    presetStep('final-gate', 'final-gate', 'Финальная проверка', [after], { gate: [COVERED] }),
    presetStep('publish', 'publish', 'Публикация', ['final-gate']),
    presetStep('answer-reviewers', 'answer-reviewers', 'Ответы ревьюерам', ['publish']),
  ];
}

/** Тело работы: план → работа → ревью → правки (ворота ревью и работы — по виду пресета). */
function body(head: string, work: StepExtra, review: StepExtra): StepDef[] {
  return [
    presetStep('plan', 'plan', 'План', [head]),
    presetStep('work', 'work', 'Работа', ['plan'], work),
    presetStep('review', 'review', 'Ревью', ['work'], review),
    presetStep('fix', 'fix', 'Правки по ревью', ['review']),
  ];
}

const intake = (text?: string): StepDef =>
  presetStep('intake', 'intake', 'Разбор запроса', [], text ? { text } : {});

const v1 = (id: PresetId, title: string, steps: StepDef[]): Scenario => ({
  id,
  version: 1,
  title,
  steps,
});

export const PRESETS: readonly Scenario[] = [
  v1('bug-fix', 'Исправление ошибки', [
    intake(),
    // Тест регрессии ядро гонит «красным до» (P94): ворота работы, а не слово модели.
    ...body('intake', { gate: [RED_BEFORE] }, { gate: [NO_BLOCKING] }),
    ...delivery('fix'),
  ]),
  v1('feature', 'Новая возможность', [
    intake(),
    ...body('intake', {}, { gate: [NO_BLOCKING] }),
    ...delivery('fix'),
  ]),
  v1('refactor', 'Рефакторинг', [
    intake(),
    ...body('intake', {}, { gate: [NO_BLOCKING, EQUIVALENT] }),
    ...delivery('fix'),
  ]),
  // Только ревью: разбор считает MR, итог — отчёт; публикация — лишь по просьбе (02:19-20).
  v1('review-only', 'Только ревью', [
    intake('Count the merge requests to review and list each one.'),
    presetStep('review', 'review', 'Ревью', ['intake'], { gate: [NO_BLOCKING] }),
    presetStep('report', 'report', 'Отчёт', ['review']),
  ]),
  v1('tracker-ticket', 'Задача из трекера', [
    intake('Read the tracker ticket; extract every requirement it states.'),
    ...body('intake', {}, { gate: [NO_BLOCKING] }),
    ...delivery('fix'),
    // Статус в трекере — запись под политикой человека (точка 9), шаг модели после публикации.
    presetStep('tracker-status', 'custom', 'Статус в трекере', ['answer-reviewers'], {
      text: 'Update the tracker ticket status to reflect the published merge request.',
    }),
  ]),
  // Поздние заметки ревьюеров в MR законченной задачи (05:77): задачу открывает опрос форжа.
  // Работы до публикации нет — первая публикация пушит ничего в тот же MR и один раз читает нити,
  // ответ (с правкой или без) возвращает финальные ворота и публикацию, которая несёт и правку,
  // и ответы (G15). Ворот `requirements-covered` нет: сверить извлечение здесь некому (ни плана,
  // ни ревью), и ворота не открылись бы никогда; готовность публикатора всё равно требует, чтобы
  // открытых требований не было.
  v1('answer-reviewers', 'Ответы ревьюерам', [
    intake(
      'Read the forge events that opened this task and the open threads of its merge request; list what each reviewer asks. Do not change files.',
    ),
    presetStep('final-gate', 'final-gate', 'Финальная проверка', ['intake']),
    presetStep('publish', 'publish', 'Публикация', ['final-gate']),
    presetStep('answer-reviewers', 'answer-reviewers', 'Ответы ревьюерам', ['publish']),
  ]),
  // Чат панели (этап 10): один открытый шаг — ход человека = сообщение шагу, конец — `end-chat`
  // или отмена. Хвоста доставки нет: публикация из чата — только через вопрос человеку. Срок
  // пустой (`budgetMs` 0): чат ждёт человека сколько угодно, срок шага его бы обрывал.
  v1('chat', 'Чат', [presetStep('chat', 'chat', 'Чат', [])]),
  // Лёгкая сессия панели (этап 10, F2, `POST /v1/ask`): тот же шаг чата, но его закрывает ядро на
  // конце первого хода (`next/active.ts`), а не `end-chat`; место — временный каталог ядра.
  v1('ask', 'Вопрос модели', [presetStep('ask', 'chat', 'Ответ', [])]),
  // Ревью MR по ссылке (этап 10, F8 — перенос карточки ревью старой панели). Единица 0 — копия на
  // ветке MR (`POST /v1/review-link`), дифф ревью — от общего предка с целевой веткой. После
  // ревью человек решает (точка 8); «правки» идут только по «починить»/«оба», пуш — отдельным
  // вопросом после правок, публикация несёт итог в MR (заметкой) и/или пуш. Какие шаги
  // пропускаются — правила `next/review-link.ts`, не порядок шагов. Правка зависит от решения,
  // а не от ревью: правка, сданная после ревью, не делает его устаревшим (второго ревью нет).
  v1('review-link', 'Ревью MR по ссылке', [
    intake(
      'Read the merge request named in the request: its description and the open threads (section threads). List what it changes. Do not change files.',
    ),
    presetStep('review', 'review', 'Ревью', ['intake'], {
      text: 'Review only the merge request changes: git diff <review base>...HEAD in the copy. Report every finding in step_done findings (file, line, severity, text). Do not change files.',
    }),
    {
      ...presetStep(REVIEW_DECIDE_STEP, 'ask-human', 'Решение по замечаниям', ['review']),
      ask: REVIEW_LINK_ASKS[REVIEW_DECIDE_STEP]!.ru,
    },
    presetStep('fix', 'fix', 'Правки по ревью', [REVIEW_DECIDE_STEP]),
    {
      ...presetStep(REVIEW_PUSH_STEP, 'ask-human', 'Отправка в MR', ['fix']),
      ask: REVIEW_LINK_ASKS[REVIEW_PUSH_STEP]!.ru,
    },
    presetStep('final-gate', 'final-gate', 'Финальная проверка', [REVIEW_PUSH_STEP]),
    presetStep('publish', 'publish', 'Публикация', ['final-gate']),
  ]),
];

export function isPresetId(id: string): id is PresetId {
  return PRESETS.some((p) => p.id === id);
}

/** Пресет по ссылке; другой версии в коде нет — `undefined`, а не ближайшая. */
export function presetOf(ref: ScenarioRef): Scenario | undefined {
  return PRESETS.find((p) => p.id === ref.id && p.version === ref.version);
}

/** Последние версии пресетов — что предлагают взамен негодного сценария. */
export function latestPresets(): Scenario[] {
  const latest = new Map<string, Scenario>();
  for (const p of PRESETS) {
    const seen = latest.get(p.id);
    if (!seen || seen.version < p.version) latest.set(p.id, p);
  }
  return [...latest.values()];
}
