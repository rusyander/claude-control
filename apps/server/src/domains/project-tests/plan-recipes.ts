import type {
  ProjectTestCase,
  ProjectTestCoverage,
  ProjectTestGroup,
  ProjectTestImpact,
  ProjectTestPlan,
  ProjectTestPlanBuildRequest,
  ProjectTestPlanPick,
  ProjectTestPlanPreview,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';
import { DEFAULT_CASE_DURATION, pickWithinBudget } from '@agentdeck/contracts/test-format';
import { ProjectTestsError } from './files.ts';
import { buildRisk } from './risk.ts';
import { flakyCases } from './runs-store.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Сборка тест-плана ПРАВИЛОМ, а не агентом.
 *
 * План — это отбор по счётным признакам: важность, последний результат, минуты,
 * дифф рабочей копии, требования вехи, стабильность по истории. Всё это лежит в
 * файлах рядом и считается за миллисекунды. Агент на том же месте добавляет
 * только разброс («сегодня взял эти двадцать, завтра другие») и расход окна, а
 * объяснить свой выбор не может — тогда как человека интересует ровно обратное:
 * что НЕ попало в план и почему.
 *
 * Отсюда два свойства модуля. Ноль токенов: генераторы работают на машине без
 * сети и без установленного CLI. Чистота: ни git, ни диск, ни Jira здесь не
 * читаются, всё нужное приходит параметрами (`impact`, `coverage`, `runs`), а
 * чтением занимается вызывающий маршрут, — потому каждый генератор и проверяется
 * юнитом на выдуманной библиотеке.
 *
 * Результат — предпросмотр, а не сохранённый план: человек сначала смотрит «12
 * кейсов, 28 минут, не влезло 3». `toPlan` превращает его в обычный
 * `ProjectTestPlan`, который дальше правится руками как любой другой.
 */

/**
 * Во сколько минут обходится кейс без своей оценки — общее допущение панели.
 *
 * Живёт в `test-format`, потому что тем же числом считает бюджет экран
 * библиотеки: два допущения дали бы «не влезло 3» на экране и «не влезло 5» в
 * собранном плане при одном и том же наборе.
 */
export { DEFAULT_CASE_DURATION };

/** Бюджет «дыма», когда его не задали: полчаса — столько ждут перед выкладкой. */
export const DEFAULT_SMOKE_BUDGET = 30;

/**
 * Порог «нестабильных» по умолчанию, доля 0–1. Кейс, меняющий результат чаще
 * чем в каждом пятом переходе, чинят как сломанный тест, а не как найденный баг.
 */
export const DEFAULT_FLAKY_THRESHOLD = 0.8;

/** Данные, которые собрал вызывающий: сам генератор не читает ни диск, ни сеть. */
export interface PlanRecipeInput extends ProjectTestPlanBuildRequest {
  groups: ProjectTestGroup[];
  /** Для `diff`: результат `impactOf` — он и ходит в git. */
  impact?: ProjectTestImpact;
  /** Для `release`: матрица покрытия, собранная под эту веху. */
  coverage?: ProjectTestCoverage;
  /** Для `release` и `flaky`: история прогонов от новых к старым (`readRuns`). */
  runs?: ProjectTestRunRecord[];
}

/** Чем дополнить план поверх предпросмотра. */
export interface PlanFromPreviewOptions {
  /** Идентификатор; пусто — `savePlan` подберёт свободный сам. */
  id?: string;
  title?: string;
  environmentId?: string;
  tags?: string[];
}

/** Кейс-кандидат вместе с причиной, по которой правило его назвало. */
interface Candidate {
  groupId: string;
  testCase: ProjectTestCase;
  reason: string;
}

/** Что вернул генератор: отобранное и заведомо отвергнутое (с причиной). */
interface RecipeResult {
  candidates: Candidate[];
  left: Candidate[];
}

/** Живые кейсы всех разобравшихся групп: архивные в план не попадают никогда. */
function liveCases(groups: ProjectTestGroup[]): Candidate[] {
  const result: Candidate[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      result.push({ groupId: group.id, testCase, reason: '' });
    }
  }
  return result;
}

/** Указатель «группа:кейс» → кейс: по нему находят кейсы, названные чужим отбором. */
function caseIndex(groups: ProjectTestGroup[]): Map<string, Candidate> {
  return new Map(liveCases(groups).map((item) => [`${item.groupId}:${item.testCase.id}`, item]));
}

/** Собственная оценка кейса; ноль и мусор считаются отсутствием оценки. */
function ownDuration(testCase: ProjectTestCase): number | undefined {
  const value = testCase.duration;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Кандидат в строку предпросмотра.
 *
 * Допущение о длительности приписывается к причине только там, где минуты
 * действительно считают: кейсу, отвергнутому порогом стабильности, оценка
 * времени ничего не объясняет и только мешает читать причину.
 */
function toPick(candidate: Candidate, countMinutes = true): ProjectTestPlanPick {
  const own = ownDuration(candidate.testCase);
  const reason =
    own === undefined && countMinutes
      ? `${candidate.reason}; длительность не указана — считаем ${DEFAULT_CASE_DURATION} мин`
      : candidate.reason;
  return {
    groupId: candidate.groupId,
    caseId: candidate.testCase.id,
    title: candidate.testCase.title,
    priority: candidate.testCase.priority,
    duration: own ?? DEFAULT_CASE_DURATION,
    reason,
  };
}

/** Один и тот же кейс не берётся дважды: первая причина сильнее следующих. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.groupId}:${candidate.testCase.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/**
 * Набить бюджет по порядку кандидатов.
 *
 * Само правило — общее (`pickWithinBudget`): им же считает бюджет экран
 * библиотеки, и расходиться им нельзя. Здесь к нему добавляется только причина
 * словами — то, ради чего человек и открывает «не влезло».
 */
function applyBudget(
  candidates: Candidate[],
  budget?: number,
): { picked: ProjectTestPlanPick[]; left: ProjectTestPlanPick[]; minutes: number } {
  // Общему правилу нужен ключ и минуты; и то и другое у `ProjectTestPlanPick`
  // уже есть, кроме ключа — он собирается здесь и в ответ не уезжает.
  const picks = candidates.map((candidate) => ({
    ...toPick(candidate),
    key: `${candidate.groupId}:${candidate.testCase.id}`,
    duration: ownDuration(candidate.testCase) ?? DEFAULT_CASE_DURATION,
  }));
  const strip = ({
    key: _key,
    taken: _taken,
    ...pick
  }: (typeof picks)[number] & { taken?: number }) => pick;

  if (budget === undefined) {
    return {
      picked: picks.map(strip),
      left: [],
      minutes: picks.reduce((total, pick) => total + pick.duration, 0),
    };
  }

  const fit = pickWithinBudget(picks, budget);
  return {
    picked: fit.picked.map(strip),
    left: fit.left.map((item) => ({
      ...strip(item),
      reason: `не влез в бюджет ${budget} мин: набрано ${item.taken}, кейс просит ${item.duration}`,
    })),
    minutes: fit.minutes,
  };
}

/**
 * «Дым»: вся библиотека по РИСКУ — бюджет обрежет хвост.
 *
 * Риск считает `risk.ts` теми же пятью множителями, что и сортировка в
 * библиотеке: важность здесь один из них, а не первый ключ сортировки. Иначе
 * «дым» и экран расходились бы в главном — какой кейс взять первым, — и человек
 * получал бы в плане не то, что видел глазами минуту назад.
 */
function smokeRecipe(
  groups: ProjectTestGroup[],
  runs: ProjectTestRunRecord[],
  impact?: ProjectTestImpact,
): RecipeResult {
  const index = caseIndex(groups);
  const candidates: Candidate[] = [];

  for (const item of buildRisk(groups, runs, { impact }).items) {
    const found = index.get(item.key);
    if (found) candidates.push({ ...found, reason: `риск ${item.score}: ${item.reason}` });
  }
  return { candidates, left: [] };
}

/**
 * «Регрессия по диффу»: задетые правками кейсы и их соседи по зоне.
 *
 * Соседи берутся намеренно: правка внутри зоны ломает не только тот кейс, чьи
 * `codePaths` совпали буквально, а весь угол приложения — иначе отбор проверял
 * бы ровно то, что автор и так только что смотрел руками.
 */
function diffRecipe(groups: ProjectTestGroup[], impact?: ProjectTestImpact): RecipeResult {
  const index = caseIndex(groups);
  const direct: Candidate[] = [];
  for (const hit of impact?.cases ?? []) {
    const found = index.get(`${hit.groupId}:${hit.caseId}`);
    if (found) direct.push({ ...found, reason: hit.reason });
  }

  const areas = new Set(
    direct
      .map((item) => item.testCase.area?.trim().toLowerCase())
      .filter((area): area is string => Boolean(area)),
  );
  const neighbours = liveCases(groups)
    .filter((item) => areas.has(item.testCase.area?.trim().toLowerCase() ?? ''))
    .map((item) => ({ ...item, reason: `сосед по зоне «${item.testCase.area}»` }));

  return { candidates: dedupe([...direct, ...neighbours]), left: [] };
}

/**
 * Красное с прошлой вехи.
 *
 * История идёт от новых к старым, и границей служит первый прогон, помеченный
 * ДРУГОЙ вехой: всё, что после него, относится к текущей. Вехи в запросе нет —
 * текущей считается первая встреченная метка, потому что «прошлая веха» без
 * единой метки в истории не определена вовсе.
 */
function redSincePreviousRelease(
  runs: ProjectTestRunRecord[],
  release?: string,
): Map<string, string> {
  const found = new Map<string, string>();
  let current = release?.trim() || undefined;

  for (const run of runs) {
    const tag = run.release?.trim();
    if (tag) {
      if (!current) current = tag;
      else if (tag !== current) break;
    }
    for (const result of run.results) {
      if (result.status !== 'failed' && result.status !== 'blocked') continue;
      const key = `${result.groupId}:${result.caseId}`;
      if (!found.has(key)) {
        found.set(key, `красный с прошлой вехи (прогон от ${run.startedAt.slice(0, 10)})`);
      }
    }
  }
  return found;
}

/** «План вехи»: кейсы её требований плюс всё красное с прошлой вехи. */
function releaseRecipe(
  groups: ProjectTestGroup[],
  coverage?: ProjectTestCoverage,
  runs?: ProjectTestRunRecord[],
  release?: string,
): RecipeResult {
  const index = caseIndex(groups);
  const candidates: Candidate[] = [];

  // Матрица покрытия приходит уже собранной ПОД ЭТУ веху (запрос выбирает
  // маршрут), поэтому здесь требованиями вехи считаются все её строки.
  for (const item of coverage?.items ?? []) {
    for (const covered of item.cases) {
      const found = index.get(`${covered.groupId}:${covered.caseId}`);
      if (found) candidates.push({ ...found, reason: `требование ${item.key}` });
    }
  }

  for (const [key, reason] of redSincePreviousRelease(runs ?? [], release)) {
    const found = index.get(key);
    if (found) candidates.push({ ...found, reason });
  }

  return { candidates: dedupe(candidates), left: [] };
}

/**
 * Порог стабильности в процентах.
 *
 * По контракту он приходит долей 0–1, а `stabilityOf` считает проценты. Число
 * больше единицы принимается как уже проценты: «80» в поле порога — слишком
 * естественная описка, чтобы молча отдать пустой план.
 */
function thresholdPercent(threshold?: number): number {
  const value =
    typeof threshold === 'number' && threshold > 0 ? threshold : DEFAULT_FLAKY_THRESHOLD;
  return Math.round(value <= 1 ? value * 100 : value);
}

/** «Нестабильные»: стабильность по истории ниже порога. */
function flakyRecipe(
  groups: ProjectTestGroup[],
  runs: ProjectTestRunRecord[],
  threshold?: number,
): RecipeResult {
  const percent = thresholdPercent(threshold);
  const index = caseIndex(groups);
  const candidates: Candidate[] = [];
  const left: Candidate[] = [];

  // `flakyCases` уже считает стабильность по `stabilityOf` и не показывает
  // кейсы, ни разу не менявшие результат: в «не влезло» им тоже не место —
  // сотня стабильных строк там ничего не объясняет.
  for (const row of flakyCases(runs, groups)) {
    const found = index.get(`${row.groupId}:${row.caseId}`);
    if (!found) continue;
    const tail = `на ${row.runs} прогонах, порог ${percent}%`;
    if (row.stability < percent) {
      candidates.push({ ...found, reason: `стабильность ${row.stability}% ${tail}` });
      continue;
    }
    left.push({ ...found, reason: `стабильность ${row.stability}% — не ниже порога ${percent}%` });
  }
  return { candidates, left };
}

/** Название плана по умолчанию — то же, что человек увидит в списке планов. */
function defaultTitle(input: PlanRecipeInput, budget?: number): string {
  if (input.title?.trim()) return input.title.trim();
  if (input.recipe === 'smoke') return `Дым за ${budget ?? DEFAULT_SMOKE_BUDGET} мин`;
  if (input.recipe === 'diff') return 'Регрессия по диффу';
  if (input.recipe === 'release') {
    return input.release?.trim() ? `План вехи ${input.release.trim()}` : 'План вехи';
  }
  return `Нестабильные: стабильность ниже ${thresholdPercent(input.threshold)}%`;
}

/** Выбрать генератор. Неизвестный рецепт — ошибка, а не молча пустой план. */
function runRecipe(input: PlanRecipeInput): RecipeResult {
  switch (input.recipe) {
    case 'smoke':
      return smokeRecipe(input.groups, input.runs ?? [], input.impact);
    case 'diff':
      return diffRecipe(input.groups, input.impact);
    case 'release':
      return releaseRecipe(input.groups, input.coverage, input.runs, input.release);
    case 'flaky':
      return flakyRecipe(input.groups, input.runs ?? [], input.threshold);
    default:
      throw coded(
        new ProjectTestsError(`Неизвестное правило сборки плана: «${String(input.recipe)}».`),
        'plan-recipe-unknown',
        { recipe: String(input.recipe) },
      );
  }
}

/**
 * Собрать предпросмотр плана.
 *
 * Бюджет обязателен только «дыму» (там он и по умолчанию есть), но применим к
 * любому рецепту: «регрессия по диффу за 20 минут» — такой же законный вопрос.
 */
export function buildPlanPreview(input: PlanRecipeInput): ProjectTestPlanPreview {
  const budget =
    typeof input.budget === 'number' && input.budget > 0 ? Math.round(input.budget) : undefined;
  const effectiveBudget = input.recipe === 'smoke' ? (budget ?? DEFAULT_SMOKE_BUDGET) : budget;

  const { candidates, left } = runRecipe(input);
  const fitted = applyBudget(candidates, effectiveBudget);

  return {
    recipe: input.recipe,
    title: defaultTitle(input, effectiveBudget),
    picked: fitted.picked,
    left: [...left.map((item) => toPick(item, false)), ...fitted.left],
    minutes: fitted.minutes,
    budget: effectiveBudget,
  };
}

/** Откуда взялся план — строкой, которую человек прочитает через месяц. */
function describe(preview: ProjectTestPlanPreview): string {
  const parts = [
    `Собран правилом «${preview.title}». Кейсов: ${preview.picked.length}, минут: ${preview.minutes}.`,
  ];
  if (preview.budget !== undefined) parts.push(`Бюджет: ${preview.budget} мин.`);
  if (preview.left.length > 0) parts.push(`Не вошло: ${preview.left.length}.`);
  return parts.join(' ');
}

/**
 * Предпросмотр → обычный тест-план.
 *
 * Состав пишется статическим списком, а не фильтром: правило считало его по
 * состоянию НА СЕЙЧАС (что красное, что задето диффом), и динамический набор
 * молча поменялся бы к моменту прогона. Кейсы записываются в виде
 * «группа:кейс» — идентификаторы уникальны только внутри группы.
 *
 * Идентификатор по умолчанию пустой: пусть `savePlan` подберёт свободный, иначе
 * повторная сборка затирала бы план, который уже правили руками.
 */
export function toPlan(
  preview: ProjectTestPlanPreview,
  options: PlanFromPreviewOptions = {},
): ProjectTestPlan {
  return {
    id: options.id ?? '',
    title: options.title?.trim() || preview.title,
    description: describe(preview),
    caseIds: preview.picked.map((pick) => `${pick.groupId}:${pick.caseId}`),
    environmentIds: options.environmentId ? [options.environmentId] : undefined,
    tags: options.tags?.length ? options.tags : undefined,
  };
}
