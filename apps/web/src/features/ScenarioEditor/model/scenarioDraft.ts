import {
  PRESET_IDS,
  ROUND_CAP_DEFAULT,
  scenarioProblems,
  scenarioSchema,
  STEP_TIER_OF,
  type Scenario,
  type ScenarioRef,
  type StepDef,
  type StepKind,
} from '@agentdeck/contracts/core/scenario';
import type { ScenarioView } from '@agentdeck/contracts/core/task-view';
import { moveAfter } from '@entities/StepPath';

/**
 * Черновик сценария ядра в редакторе панели (07:27, 02 §Scenario). Редактор растёт из «Порядка
 * работы» групп: шаги стоят цепочкой по порядку экрана, `after` каждого шага — предыдущий шаг
 * (как у пресетов). Версию человек не вводит: она всегда «последняя в библиотеке + 1» — ядро
 * пишет версию один раз (F6) и правку задачи принимает только следующей по счёту.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Свободный id шага от основы: `work`, `work-2`, `work-3`… (id шагов в сценарии различны). */
export function uniqueStepId(base: string, taken: readonly string[]): string {
  const root = SLUG.test(base) ? base : 'step';
  if (!taken.includes(root)) return root;
  for (let n = 2; ; n += 1) {
    const id = `${root}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

/** Вопрос человеку по умолчанию: схема требует ≥ 2 вариантов и рекомендацию из них. */
function defaultAsk(question: string): NonNullable<StepDef['ask']> {
  return { question, options: ['Да', 'Нет'], recommendation: 'Да' };
}

/** Новый шаг вида `kind`: каждое поле схемы названо, значения — канон пресетов (круги 2, «спросить»). */
export function newStep(kind: StepKind, title: string, taken: readonly string[]): StepDef {
  return {
    id: uniqueStepId(kind, taken),
    kind,
    title,
    after: [],
    knowledge: { skills: [], rules: [], hooks: [], scripts: [] },
    model: { tier: STEP_TIER_OF[kind] },
    checks: { mid: 'narrow', required: [] },
    roundCap: ROUND_CAP_DEFAULT,
    budget: {},
    overBudget: 'ask',
    userLayer: { hooks: 'on', skills: 'on' },
    gate: [],
    ...(kind === 'ask-human' ? { ask: defaultAsk(title) } : {}),
  };
}

/** Смена вида: поля, которые схема разрешает только одному виду, уходят или появляются. */
export function withKind(step: StepDef, kind: StepKind): StepDef {
  const { ask, within, regression, publish, ...rest } = step;
  return {
    ...rest,
    kind,
    ...(kind === 'ask-human' ? { ask: ask ?? defaultAsk(step.title) } : {}),
    ...(kind === 'work' && within ? { within } : {}),
    ...(kind === 'work' && regression ? { regression } : {}),
    ...(kind === 'publish' && publish ? { publish } : {}),
  };
}

/** Цепочка по порядку экрана: первый шаг ни за кем, каждый следующий — за предыдущим. */
export function chained(steps: readonly StepDef[]): StepDef[] {
  return steps.map((step, index) => {
    const prev = steps[index - 1];
    return { ...step, after: prev ? [prev.id] : [] };
  });
}

/**
 * Порядок показа шагов загруженного сценария: устойчивая топологическая сортировка по `after`
 * (порядок файла, пока зависимости позволяют). Цикл не роняет показ — оставшиеся шаги идут как
 * в файле, сам цикл назовёт `scenarioProblems`.
 */
export function orderedSteps(steps: readonly StepDef[]): StepDef[] {
  const placed = new Set<string>();
  const out: StepDef[] = [];
  const known = new Set(steps.map((s) => s.id));
  let rest = [...steps];
  while (rest.length > 0) {
    const next = rest.find((s) => s.after.every((dep) => placed.has(dep) || !known.has(dep)));
    if (!next) return [...out, ...rest];
    out.push(next);
    placed.add(next.id);
    rest = rest.filter((s) => s !== next);
  }
  return out;
}

/**
 * Сценарий — простая цепочка: в порядке показа каждый шаг ждёт ровно предыдущий. Иначе
 * (ветви, общий предок) редактор предупреждает: сохранение выпрямит зависимости в цепочку.
 */
export function isChain(steps: readonly StepDef[]): boolean {
  const ordered = orderedSteps(steps);
  return ordered.every((step, index) => {
    const prev = ordered[index - 1];
    return prev ? step.after.length === 1 && step.after[0] === prev.id : step.after.length === 0;
  });
}

export function insertStepAfter(
  steps: readonly StepDef[],
  afterIndex: number,
  step: StepDef,
): StepDef[] {
  const at = Math.max(-1, Math.min(afterIndex, steps.length - 1));
  return chained([...steps.slice(0, at + 1), step, ...steps.slice(at + 1)]);
}

export function removeStepAt(steps: readonly StepDef[], index: number): StepDef[] {
  return chained(steps.filter((_, i) => i !== index));
}

/** Перенос шага на место после `afterIndex` — то же правило места, что у «Порядка работы». */
export function moveStep(steps: readonly StepDef[], from: number, afterIndex: number): StepDef[] {
  return chained(moveAfter(steps, from, afterIndex));
}

export function replaceStepAt(steps: readonly StepDef[], index: number, step: StepDef): StepDef[] {
  return chained(steps.map((s, i) => (i === index ? step : s)));
}

export interface LibraryListing {
  presets: Scenario[];
  library: Scenario[];
}

export function isPresetId(id: string): boolean {
  return (PRESET_IDS as readonly string[]).includes(id);
}

/** Версия, под которой сохранится `id`: последняя в библиотеке + 1 (первая — 1). */
export function nextVersion(library: readonly Scenario[], id: string): number {
  return library.reduce((max, s) => (s.id === id && s.version > max ? s.version : max), 0) + 1;
}

/** id без пресетного: пресеты принадлежат коду ядра, правку человек хранит под своим id. */
export function ownIdFor(base: string, library: readonly Scenario[]): string {
  if (!isPresetId(base)) return base;
  const taken = new Set(library.map((s) => s.id));
  const root = `${base}-own`.slice(0, 64);
  if (!taken.has(root) && !isPresetId(root)) return root;
  return uniqueStepId(root, [...taken]);
}

export interface EditorDraft {
  id: string;
  title: string;
  presetOf?: ScenarioRef;
  steps: StepDef[];
}

/** Черновик «на основе»: шаги в порядке показа, id — свой, если основа — пресет. */
export function draftFrom(base: Scenario, library: readonly Scenario[]): EditorDraft {
  const presetOf = isPresetId(base.id) ? { id: base.id, version: base.version } : base.presetOf;
  return {
    id: ownIdFor(base.id, library),
    title: base.title,
    ...(presetOf ? { presetOf } : {}),
    steps: orderedSteps(base.steps),
  };
}

/** Сценарий, который уйдёт в ядро: цепочка `after` и версия «последняя + 1». */
export function scenarioOf(draft: EditorDraft, library: readonly Scenario[]): Scenario {
  return {
    id: draft.id,
    version: nextVersion(library, draft.id),
    title: draft.title,
    ...(draft.presetOf ? { presetOf: draft.presetOf } : {}),
    steps: chained(draft.steps),
  };
}

export interface DraftProblem {
  /** Путь поля (`steps.2.title`) или пусто для правила сценария целиком. */
  path: string;
  message: string;
}

/**
 * Почему черновик не сохранить — ДО запроса: та же строгая схема и тот же `scenarioProblems`,
 * что у ядра (один модуль контрактов на обоих), плюс пресетный id. Пусто — ядро примет форму;
 * суд полномочий и однократность записи решает только ядро.
 */
export function draftProblems(scenario: Scenario): DraftProblem[] {
  const parsed = scenarioSchema.safeParse(scenario);
  const out: DraftProblem[] = parsed.success
    ? scenarioProblems(parsed.data).map((message) => ({ path: '', message }))
    : parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
  if (isPresetId(scenario.id)) {
    out.unshift({ path: 'id', message: `${scenario.id} is a built-in preset id` });
  }
  return out;
}

/** Ссылка `id@v` — адрес ядра `GET /v1/scenarios/:ref` и значение `?id=` страницы. */
export function refText(ref: ScenarioRef): string {
  return `${ref.id}@${ref.version}`;
}

const REF = /^([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]{0,8})$/;

export function parseRef(text: string | undefined): ScenarioRef | undefined {
  const match = text ? REF.exec(text) : null;
  return match ? { id: match[1] as string, version: Number(match[2]) } : undefined;
}

/**
 * Сценарий задачи из вида ядра (`GET /v1/tasks/:id` поле `view.scenario`): действующая ссылка и
 * ожидающая правка. Правка идёт от последней — ожидающей, если она есть (ядро сравнивает
 * `baseVersion` с ней же, `latestTaskScenario`). Сценария нет — `undefined`.
 */
export function taskScenarioOf(
  view: ScenarioView | null | undefined,
): { current: ScenarioRef; pending: boolean } | undefined {
  if (!view) return undefined;
  const to = view.pending?.to;
  return { current: to ?? view.ref, pending: Boolean(to) };
}
