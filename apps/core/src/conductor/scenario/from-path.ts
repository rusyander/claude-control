import { registryId } from '@agentdeck/contracts/core/ids';
import {
  scenarioProblems,
  scenarioSchema,
  type Gate,
  type Scenario,
  type StepDef,
} from '@agentdeck/contracts/core/scenario';
import {
  migrateScenarioSteps,
  PATH_ANCHORS,
  type PathAnchor,
  type PathStep,
} from '@agentdeck/contracts/group-path';
import { presetStep } from './presets.ts';
import { issuesOf } from './library.ts';
import { STEP_TITLES, type TitleLang, type TitlePair } from './titles.ts';

/**
 * Перенос «Пути» группы панели в сценарий ядра (02:23-28, P100): одна миграция на все хранимые
 * пути. Встроенные стадии конвейера становятся шагами (`triage` → `intake` до плана, `deliver` →
 * финальные ворота + публикация), свой шаг — шагом после своей стадии в порядке `order`, `prompt` —
 * текстом знаний, `resource` — знанием своего вида, `gate` — воротами `text`. Ничего не
 * выбрасывается: то, что не помещается в схему, — проблема с именем, а не обрезка.
 */

/** Старый «Порядок работы» группы (`scenario.steps`) — до «Пути». */
export interface LegacySteps {
  steps: { title: string; body: string; gate: string }[];
}

export interface PathSource {
  /** id будущего сценария в библиотеке (slug). */
  id: string;
  title: string;
  /** `scenario` — шаги группы и есть вся работа, стадий нет (`groups.ts` flow). */
  flow?: 'conveyor' | 'scenario';
  path?: { steps: PathStep[] };
  legacy?: LegacySteps;
  /**
   * Язык заголовков шагов — тот, что у панели: и стадии, и свои шаги называются на нём одном.
   * Без него — русский, как у встроенных пресетов. Текст и ворота модель читает по-английски всегда.
   */
  lang?: TitleLang;
}

export type { TitleLang };

export interface FromPathResult {
  /** `null`, если есть проблемы: сценарий без части пути хуже отказа (P100). */
  scenario: Scenario | null;
  problems: string[];
  /** id шага «Пути» → id шага сценария. */
  ids: Record<string, string>;
}

/** Модель читает английскую сторону (`group-path.ts`); пустая — значит, не переведено. */
const side = (t: { ru: string; en: string } | undefined): string =>
  (t?.en.trim() ? t.en : (t?.ru ?? '')).trim();

/** Заголовок читает человек: сторона языка панели, пустая — другая сторона (не переведено). */
const titleSide = (t: { ru: string; en: string }, lang: TitleLang): string => {
  const other: TitleLang = lang === 'en' ? 'ru' : 'en';
  return (t[lang].trim() || t[other]).trim();
};

/** Встроенные стадии называются теми же строками, что шаги пресетов (`titles.ts`). */
const stageTitle = (id: StageStepId, lang: TitleLang): string =>
  (STEP_TITLES[id] as TitlePair)[lang];

type StageStepId = 'intake' | 'plan' | 'work' | 'review' | 'fix' | 'final-gate' | 'publish';

const KNOWLEDGE_OF = {
  skill: 'skills',
  rule: 'rules',
  hook: 'hooks',
  script: 'scripts',
} as const;

const TEXT_MAX = 16_000;
const CRITERION_MAX = 2000;

function customStep(
  step: PathStep,
  id: string,
  after: string[],
  problems: string[],
  lang: TitleLang,
): StepDef {
  const where = `path step ${step.id}`;
  const title = titleSide(step.title, lang) || `step ${id}`;
  const base = presetStep(id, step.within ? 'work' : 'custom', title.slice(0, 200), after);
  if (title.length > 200) problems.push(`${where}: title longer than 200`);
  const text = side(step.prompt);
  if (text.length > TEXT_MAX) problems.push(`${where}: prompt longer than ${TEXT_MAX}`);
  const knowledge = { ...base.knowledge, ...(text ? { text } : {}) };
  if (step.resource) {
    if (!registryId.safeParse(step.resource.id).success)
      problems.push(`${where}: resource id ${step.resource.id} is not a registry id`);
    knowledge[KNOWLEDGE_OF[step.resource.type]] = [step.resource.id];
  }
  const criterion = side(step.gate);
  if (criterion.length > CRITERION_MAX)
    problems.push(`${where}: gate longer than ${CRITERION_MAX}`);
  const gate: Gate[] = criterion ? [{ kind: 'text', criterion }] : [];
  return {
    ...base,
    knowledge,
    gate,
    ...(step.within
      ? {
          within: {
            skillId: step.within.skillId,
            index: step.within.index,
            after: step.within.after,
          },
        }
      : {}),
  };
}

/** Встроенная стадия → шаги ядра; канон тот же, что у пресета `feature`. */
function stageSteps(stage: PathAnchor, after: string[], lang: TitleLang): StepDef[] {
  const title = (id: StageStepId): string => stageTitle(id, lang);
  switch (stage) {
    case 'triage':
      return [presetStep('intake', 'intake', title('intake'), after)];
    case 'plan':
      return [presetStep('plan', 'plan', title('plan'), after)];
    case 'work':
      return [presetStep('work', 'work', title('work'), after)];
    case 'review':
      return [
        presetStep('review', 'review', title('review'), after, {
          gate: [{ kind: 'review-no-blocking' }],
        }),
      ];
    case 'fix':
      return [presetStep('fix', 'fix', title('fix'), after)];
    case 'deliver':
      return [
        presetStep('final-gate', 'final-gate', title('final-gate'), after, {
          gate: [{ kind: 'requirements-covered' }],
        }),
        presetStep('publish', 'publish', title('publish'), ['final-gate']),
      ];
  }
}

/** Свои шаги по стадии, внутри — по `order`, равные — в порядке хранения. */
function byAnchor(steps: readonly PathStep[]): Map<PathAnchor, PathStep[]> {
  const out = new Map<PathAnchor, PathStep[]>(PATH_ANCHORS.map((a) => [a, []]));
  steps
    .map((step, at) => ({ step, at }))
    .sort((a, b) => a.step.order - b.step.order || a.at - b.at)
    .forEach(({ step }) => out.get(step.anchor)?.push(step));
  return out;
}

export function fromPath(source: PathSource): FromPathResult {
  const problems: string[] = [];
  const ids: Record<string, string> = {};
  const lang: TitleLang = source.lang ?? 'ru';
  let stored = source.path?.steps ?? [];
  // Старый «Порядок работы» идёт через ту же миграцию, что и в панели (02:28).
  if (stored.length === 0 && source.legacy)
    stored = migrateScenarioSteps(source.legacy, '', (i) => `legacy-${i}`);
  const grouped = byAnchor(stored);
  const steps: StepDef[] = [];
  let last: string[] = [];
  let n = 0;
  const pushCustom = (step: PathStep): void => {
    n += 1;
    const id = `path-${n}`;
    ids[step.id] = id;
    steps.push(customStep(step, id, last, problems, lang));
    last = [id];
  };
  if (source.flow === 'scenario') {
    for (const anchor of PATH_ANCHORS)
      for (const step of grouped.get(anchor) ?? []) pushCustom(step);
    // Публикуют и проверяют по-прежнему ядро: сценарий группы — это работа, не доставка.
    steps.push(...stageSteps('deliver', last, lang));
  } else {
    for (const anchor of PATH_ANCHORS) {
      const builtin = stageSteps(anchor, last, lang);
      steps.push(...builtin);
      last = [builtin[builtin.length - 1]?.id as string];
      for (const step of grouped.get(anchor) ?? []) pushCustom(step);
    }
  }
  const candidate = {
    id: source.id,
    version: 1,
    title: source.title.slice(0, 200) || source.id,
    ...(source.flow === 'scenario' ? {} : { presetOf: { id: 'feature', version: 1 } }),
    steps,
  };
  const parsed = scenarioSchema.safeParse(candidate);
  if (!parsed.success) problems.push(...issuesOf(parsed.error));
  else problems.push(...scenarioProblems(parsed.data));
  return { scenario: problems.length === 0 && parsed.success ? parsed.data : null, problems, ids };
}
