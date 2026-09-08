import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestImpact,
  ProjectTestRiskBudget,
  ProjectTestRiskFactor,
  ProjectTestRiskItem,
  ProjectTestRiskReport,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';
import { caseDuration, pickWithinBudget, stabilityOf } from '@agentdeck/contracts/test-format';
import { caseStatusHistory } from './runs-store.ts';

/**
 * Риск кейса: во что обойдётся НЕ прогнать его сегодня.
 *
 * Отбор «всё подряд» не помещается ни в один рабочий день, а отбор «по
 * приоритету» игнорирует историю: кейс, падавший вчера, важнее ровно того же
 * кейса, зелёного год. Приоритет отвечает, насколько кейс важен ВООБЩЕ; риск —
 * насколько он важен ИМЕННО СЕЙЧАС, и второе меняется каждый день, пока первое
 * стоит в файле месяцами.
 *
 * ФОРМУЛА — произведение пяти множителей, каждый в (0; 1], итог × 100:
 *
 *   риск = 100 × важность × последний результат × нестабильность × давность × дифф
 *
 * Произведение, а не сумма, выбрано намеренно: слагаемые дают «сумму мелочей»,
 * при которой десяток слабых признаков перевешивает один решающий, и красный
 * блокер оказывается ниже зелёной мелочи, набравшей баллов отовсюду. У
 * произведения каждый множитель работает поправкой к остальным, а не голосом
 * наравне с ними.
 *
 * Ни один множитель не обнуляется. Кейс без истории — не безопасный кейс, а
 * непроверенный: незнание здесь стоит дороже зелёной истории, и множители
 * `instability` и `age` для него берутся выше средних, а не нулевыми.
 *
 * Модуль чистый: ни git, ни диск, ни сеть. Дифф рабочей копии приходит
 * параметром (`impactOf` его и считает), поэтому весь счёт закрывается юнитом
 * на выдуманной библиотеке и работает на машине без репозитория.
 */

/** Важность → множитель. Без важности — как у «средней»: неизвестность не скидка. */
const PRIORITY_WEIGHT: Record<string, number> = {
  blocker: 1,
  high: 0.8,
  medium: 0.55,
  low: 0.35,
};
const PRIORITY_UNSET = 0.55;

/** Со скольких дней давность перестаёт расти: месяц без прогона — уже «давно». */
const AGE_CAP_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

/** Множитель кейса, ни разу не участвовавшего в прогоне. */
const NO_HISTORY_INSTABILITY = 0.8;

export interface RiskOptions {
  /** Момент отсчёта, ISO. Пусто — сейчас. */
  now?: string;
  /** Дифф рабочей копии: `impactOf`. Пусто — множитель `impact` не сработает ни у кого. */
  impact?: ProjectTestImpact;
  /** Бюджет «у меня N минут». Пусто — отбора под бюджет в отчёте нет. */
  budget?: number;
  /** Считать только эту группу — библиотека открыта вкладкой. */
  groupId?: string;
}

function factor(
  key: ProjectTestRiskFactor['key'],
  value: number,
  note: string,
): ProjectTestRiskFactor {
  return { key, value, note };
}

/** Важность: единственный множитель, который стоит в самом кейсе. */
function priorityFactor(testCase: ProjectTestCase): ProjectTestRiskFactor {
  const known = testCase.priority ? PRIORITY_WEIGHT[testCase.priority] : undefined;
  return factor(
    'priority',
    known ?? PRIORITY_UNSET,
    known === undefined ? 'важность не задана — считаем среднюю' : `важность ${testCase.priority}`,
  );
}

/**
 * Последний результат.
 *
 * Карантин уходит вниз: его провал известен заранее и прогон им не красится —
 * тратить на такой кейс минуты, которых и так нет, незачем. Но не в ноль:
 * карантин снимают, и тогда кейс возвращается в общий счёт сам.
 */
function outcomeFactor(testCase: ProjectTestCase): ProjectTestRiskFactor {
  if (testCase.muted) return factor('outcome', 0.25, 'в карантине — провал известен заранее');
  if (testCase.status === 'failed') return factor('outcome', 1, 'последний прогон красный');
  if (testCase.status === 'blocked') return factor('outcome', 1, 'последний прогон заблокирован');
  if (testCase.status === 'unknown' || testCase.status === 'running') {
    return factor('outcome', 0.8, 'ещё не проверялся');
  }
  if (testCase.status === 'skipped') return factor('outcome', 0.7, 'последний прогон пропущен');
  return factor('outcome', 0.5, 'последний прогон зелёный');
}

/**
 * Нестабильность по истории.
 *
 * Стабильный кейс не бесплатен (0.6, а не 0), потому что «всегда зелёный» —
 * это утверждение о прошлом коде, а не о сегодняшнем. Истории нет вовсе —
 * множитель выше среднего: про такой кейс неизвестно ничего.
 */
function instabilityFactor(statuses: string[]): ProjectTestRiskFactor {
  if (statuses.length < 2) {
    return factor('instability', NO_HISTORY_INSTABILITY, 'истории прогонов нет');
  }
  const { stability } = stabilityOf(statuses);
  const value = 0.6 + 0.4 * (1 - stability / 100);
  return factor('instability', round(value), `стабильность ${stability}% на ${statuses.length}`);
}

/**
 * Давность последней проверки.
 *
 * Кейс, который не гоняли ни разу, получает максимум: непроверенное и есть
 * главный риск набора — про него нельзя сказать даже того, что он когда-то
 * работал.
 */
function ageFactor(testCase: ProjectTestCase, now: number): ProjectTestRiskFactor {
  const at = testCase.lastRunAt ? Date.parse(testCase.lastRunAt) : Number.NaN;
  if (Number.isNaN(at)) return factor('age', 1, 'ни разу не гоняли');
  const days = Math.max(Math.floor((now - at) / DAY), 0);
  const value = 0.5 + 0.5 * (Math.min(days, AGE_CAP_DAYS) / AGE_CAP_DAYS);
  const note = days === 0 ? 'гоняли сегодня' : `не гоняли ${days} дн.`;
  return factor('age', round(value), note);
}

/** Попадание в правки рабочей копии: причину даёт сам отбор по диффу. */
function impactFactor(reason: string | undefined): ProjectTestRiskFactor {
  return reason
    ? factor('impact', 1, `задет правками: ${reason}`)
    : factor('impact', 0.6, 'правки рабочей копии его не касаются');
}

/** Два знака после запятой: множители читает человек, а не только сортировка. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Итог одной строкой: то, что видно в списке без разворачивания подсказки.
 *
 * Сначала то, что кейс ТЯНЕТ ВНИЗ, — карантин, зелёная история, низкая
 * важность. Порядок «сначала самое большое» выбросил бы именно их, и кейс в
 * карантине объяснялся бы словами «важность high», то есть ровно тем, чего
 * человек в его причине не искал.
 */
function reasonOf(factors: ProjectTestRiskFactor[]): string {
  const drag = factors.filter((item) => item.value <= 0.5).sort((a, b) => a.value - b.value);
  const push = factors.filter((item) => item.value > 0.5).sort((a, b) => b.value - a.value);
  return [...drag, ...push]
    .slice(0, 3)
    .map((item) => item.note)
    .join('; ');
}

/** Живые кейсы разобравшихся групп: архив в отборе не участвует никогда. */
function liveCases(
  groups: ProjectTestGroup[],
  groupId?: string,
): { groupId: string; testCase: ProjectTestCase }[] {
  const result: { groupId: string; testCase: ProjectTestCase }[] = [];
  for (const group of groups) {
    if (group.error) continue;
    if (groupId && group.id !== groupId) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      result.push({ groupId: group.id, testCase });
    }
  }
  return result;
}

/** Риск одного кейса со всеми множителями — по нему же считается и подсказка. */
export function riskOfCase(
  groupId: string,
  testCase: ProjectTestCase,
  options: { statuses?: string[]; impactReason?: string; now?: number } = {},
): ProjectTestRiskItem {
  const factors = [
    priorityFactor(testCase),
    outcomeFactor(testCase),
    instabilityFactor(options.statuses ?? []),
    ageFactor(testCase, options.now ?? Date.now()),
    impactFactor(options.impactReason),
  ];
  const score = factors.reduce((total, item) => total * item.value, 100);

  return {
    groupId,
    caseId: testCase.id,
    key: `${groupId}:${testCase.id}`,
    title: testCase.title,
    score: Math.round(score),
    factors,
    reason: reasonOf(factors),
    duration: caseDuration(testCase.duration),
    hasDuration: typeof testCase.duration === 'number' && testCase.duration > 0,
    priority: testCase.priority,
    status: testCase.status,
    muted: testCase.muted,
  };
}

/**
 * Порядок по риску: сначала самое дорогое, при равенстве — короткое вперёд.
 *
 * Короткое вперёд не украшение: при равном риске оно даёт больше проверок за те
 * же минуты. Последнее сравнение — по ключу, чтобы два одинаковых кейса не
 * менялись местами от запуска к запуску и «не влезло» не прыгало.
 */
export function byRisk(left: ProjectTestRiskItem, right: ProjectTestRiskItem): number {
  return (
    right.score - left.score || left.duration - right.duration || left.key.localeCompare(right.key)
  );
}

/** Отбор под бюджет: «у меня N минут» — и честный список того, что не влезло. */
export function budgetOf(items: ProjectTestRiskItem[], budget: number): ProjectTestRiskBudget {
  const fit = pickWithinBudget(
    items.map((item) => ({ key: item.key, title: item.title, duration: item.duration })),
    budget,
  );
  return {
    budget,
    picked: fit.picked.map((item) => item.key),
    left: fit.left,
    minutes: fit.minutes,
  };
}

/** Риск всей библиотеки: кейсы по убыванию и, если просили, отбор под бюджет. */
export function buildRisk(
  groups: ProjectTestGroup[],
  runs: ProjectTestRunRecord[],
  options: RiskOptions = {},
): ProjectTestRiskReport {
  const checkedAt = options.now ?? new Date().toISOString();
  const now = Date.parse(checkedAt);
  const history = caseStatusHistory(runs);
  const impact = new Map(
    (options.impact?.cases ?? []).map((hit) => [`${hit.groupId}:${hit.caseId}`, hit.reason]),
  );

  const items = liveCases(groups, options.groupId)
    .map((item) =>
      riskOfCase(item.groupId, item.testCase, {
        statuses: history.get(`${item.groupId}:${item.testCase.id}`),
        impactReason: impact.get(`${item.groupId}:${item.testCase.id}`),
        now: Number.isNaN(now) ? Date.now() : now,
      }),
    )
    .sort(byRisk);

  const budget =
    typeof options.budget === 'number' && options.budget > 0
      ? budgetOf(items, Math.round(options.budget))
      : undefined;

  return {
    items,
    budget,
    changedFiles: options.impact?.files,
    checkedAt,
  };
}
