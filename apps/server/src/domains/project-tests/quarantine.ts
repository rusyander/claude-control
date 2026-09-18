import type {
  CodedMessage,
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestQuarantineReport,
  ProjectTestQuarantineSuggestion,
  ProjectTestRunRecord,
  ProjectTestStaleCase,
} from '@agentdeck/contracts';
import { stabilityOf } from '@agentdeck/contracts/test-format';
import { requirementKey } from './coverage.ts';
import { caseStatusHistory } from './runs-store.ts';

/**
 * Карантин с самоочисткой и устаревание кейсов.
 *
 * Карантин без срока годности — это тихое удаление кейса: он перестаёт красить
 * прогон, теряется среди сотни зелёных и не возвращается уже никогда. Поэтому
 * панель считает по истории, когда кейс пора вернуть в строй и когда пора
 * выключить, — и НИЧЕГО не делает сама. Оба решения остаются человеку: панель,
 * снимающая карантин по счёту зелёных, однажды вернёт в прогон кейс, который
 * держали выключенным осознанно.
 *
 * Второй вопрос того же свойства — устаревание: требование в трекере правили
 * позже кейса, и зелёный статус кейса больше ничего не доказывает. Даты
 * требований приходят снаружи (Jira), поэтому модуль их не добывает, а
 * принимает: он должен считаться и на машине без сети.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Сколько зелёных подряд нужно, чтобы предложить снять карантин. */
const DEFAULT_GREEN_STREAK = 5;

/** Ниже какой стабильности кейс предлагается выключить. */
const DEFAULT_STABILITY = 70;

/** Со скольких завершённых результатов вообще можно судить о стабильности. */
const DEFAULT_MIN_RUNS = 4;

/** Ссылки кейса, из которых получается требование. */
const REQUIREMENT_LINKS = new Set(['requirement', 'issue']);

export interface QuarantineOptions {
  /** Момент отсчёта, ISO. Пусто — сейчас. */
  now?: string;
  /** Сколько зелёных подряд снимает карантин. */
  greenStreak?: number;
  /** Порог стабильности, ниже которого предлагается карантин. */
  stability?: number;
  /** Со скольких результатов судить о стабильности. */
  minRuns?: number;
}

/** Даты правки требований в трекере: ключ задачи → когда её трогали. */
export interface RequirementDates {
  updates: Record<string, { updatedAt: string; url?: string }>;
  /** Почему список пуст или неполон — показывается строкой, а не молчанием. */
  warning?: string;
}

/**
 * Сколько зелёных подряд у кейса на сегодня.
 *
 * Серию рвут только провал и блокировка. Пропуск её не продолжает, но и не
 * рвёт: «кейс не гоняли» — не то же самое, что «кейс упал», и считать пропуск
 * поломкой значило бы держать в карантине то, что давно чинено.
 */
function greenStreakOf(statuses: string[]): number {
  let streak = 0;
  for (let i = statuses.length - 1; i >= 0; i -= 1) {
    const status = statuses[i];
    if (status === 'passed') streak += 1;
    else if (status === 'failed' || status === 'blocked') break;
  }
  return streak;
}

/** Сколько завершённых результатов в истории: по ним и судят. */
function finalCount(statuses: string[]): number {
  return statuses.filter(
    (status) =>
      status === 'passed' || status === 'failed' || status === 'skipped' || status === 'blocked',
  ).length;
}

function suggestion(
  kind: ProjectTestQuarantineSuggestion['kind'],
  groupId: string,
  testCase: ProjectTestCase,
  stats: { stability: number; runs: number; greenStreak: number },
  message: string,
  text: CodedMessage,
  reason?: string,
): ProjectTestQuarantineSuggestion {
  return {
    kind,
    groupId,
    caseId: testCase.id,
    title: testCase.title,
    message,
    ...text,
    reason,
    muteReason: testCase.muteReason,
    stability: stats.stability,
    runs: stats.runs,
    greenStreak: stats.greenStreak,
  };
}

/**
 * Кейсы, разошедшиеся с требованием.
 *
 * Кейс без даты собственной правки пропускается: сравнивать не с чем, а
 * записать его в «устаревшие» на этом основании значило бы обвинить кейс за
 * то, что его файл писали руками без метки времени.
 */
function staleCases(groups: ProjectTestGroup[], dates: RequirementDates): ProjectTestStaleCase[] {
  const stale: ProjectTestStaleCase[] = [];

  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived || !testCase.updatedAt) continue;
      const caseAt = Date.parse(testCase.updatedAt);
      if (Number.isNaN(caseAt)) continue;

      const seen = new Set<string>();
      for (const link of testCase.links ?? []) {
        if (!REQUIREMENT_LINKS.has(link.type)) continue;
        const key = requirementKey(link.url);
        if (seen.has(key)) continue;
        const update = dates.updates[key];
        if (!update) continue;
        const requirementAt = Date.parse(update.updatedAt);
        if (Number.isNaN(requirementAt) || requirementAt <= caseAt) continue;
        seen.add(key);
        stale.push({
          groupId: group.id,
          caseId: testCase.id,
          title: testCase.title,
          key,
          url: update.url ?? link.url,
          requirementUpdatedAt: update.updatedAt,
          caseUpdatedAt: testCase.updatedAt,
          days: Math.max(Math.floor((requirementAt - caseAt) / DAY), 0),
        });
      }
    }
  }

  // Самый большой разрыв — наверх: там расхождение вероятнее всего настоящее.
  return stale.sort((left, right) => right.days - left.days || left.key.localeCompare(right.key));
}

/**
 * Собрать предложения по карантину и список разошедшихся кейсов.
 *
 * Архивные кейсы не участвуют: архив и есть способ сказать «этот кейс больше не
 * наш». Нечитаемая группа пропускается — её содержимого панель не знает.
 */
export function buildQuarantine(
  groups: ProjectTestGroup[],
  runs: ProjectTestRunRecord[],
  dates: RequirementDates = { updates: {} },
  options: QuarantineOptions = {},
): ProjectTestQuarantineReport {
  const checkedAt = options.now ?? new Date().toISOString();
  const thresholds = {
    greenStreak: options.greenStreak ?? DEFAULT_GREEN_STREAK,
    stability: options.stability ?? DEFAULT_STABILITY,
    minRuns: options.minRuns ?? DEFAULT_MIN_RUNS,
  };

  const history = caseStatusHistory(runs);
  const lift: ProjectTestQuarantineSuggestion[] = [];
  const quarantine: ProjectTestQuarantineSuggestion[] = [];

  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      const statuses = history.get(`${group.id}:${testCase.id}`) ?? [];
      const { stability } = stabilityOf(statuses);
      const stats = {
        stability,
        runs: finalCount(statuses),
        greenStreak: greenStreakOf(statuses),
      };

      if (testCase.muted) {
        if (stats.greenStreak < thresholds.greenStreak) continue;
        lift.push(
          suggestion(
            'lift',
            group.id,
            testCase,
            stats,
            `Зелёных подряд: ${stats.greenStreak} при пороге ${thresholds.greenStreak}. Поломка, ради которой ставили карантин, больше не воспроизводится.`,
            {
              messageCode: 'quarantine-lift',
              params: { streak: stats.greenStreak, limit: thresholds.greenStreak },
            },
          ),
        );
        continue;
      }

      if (stats.runs < thresholds.minRuns || stability >= thresholds.stability) continue;
      quarantine.push(
        suggestion(
          'quarantine',
          group.id,
          testCase,
          stats,
          `Стабильность ${stability}% на ${stats.runs} результатах при пороге ${thresholds.stability}%: кейс то зелёный, то красный, и его провалам никто не верит.`,
          {
            messageCode: 'quarantine-suggest',
            params: { stability, runs: stats.runs, limit: thresholds.stability },
          },
          `Нестабилен: стабильность ${stability}% на ${stats.runs} результатах.`,
        ),
      );
    }
  }

  return {
    // Самая длинная серия и самый нестабильный кейс — наверх: с них и начинают.
    lift: lift.sort(
      (left, right) =>
        right.greenStreak - left.greenStreak || left.title.localeCompare(right.title),
    ),
    quarantine: quarantine.sort(
      (left, right) => left.stability - right.stability || left.title.localeCompare(right.title),
    ),
    stale: staleCases(groups, dates),
    thresholds,
    warning: dates.warning,
    checkedAt,
  };
}
