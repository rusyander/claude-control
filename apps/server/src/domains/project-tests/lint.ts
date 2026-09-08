import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestLintFinding,
  ProjectTestLintReport,
  ProjectTestLintSeverity,
} from '@agentdeck/contracts';
import { parametersInSteps } from '@agentdeck/contracts/test-format';
import { similarCases } from './similar.ts';

/**
 * Линтер библиотеки: здоровье набора счётными правилами, без агента.
 *
 * Набор кейсов гниёт тихо: кейс без способа проверки нельзя пройти честно, без
 * `codePaths` он выпадает из отбора по диффу, а `obsolete` вне архива гоняется
 * наравне с живыми. Поодиночке это мелочи — потому их и не чинит никто.
 *
 * Линтер НИЧЕГО не правит. Он называет кейс, правило и кнопку — существующее
 * массовое действие, которое нажмёт человек: автоматическая «уборка» однажды
 * сотрёт написанное руками, и доверия к разделу больше не будет.
 *
 * Времени модуль не берёт сам (`now` в настройках): отчёт, зависящий от
 * календаря машины, невоспроизводим в тесте и нестабилен в CI.
 */

/** Правила: серьёзность и имя для свода. Новое правило заводится ТОЛЬКО здесь. */
const RULES = {
  'no-oracle': { severity: 'warning', title: 'Нечем доказать результат' },
  'step-without-expected': { severity: 'warning', title: 'Шаг без ожидания' },
  'no-code-paths': { severity: 'info', title: 'Нет привязки к коду' },
  'no-priority': { severity: 'warning', title: 'Нет приоритета' },
  'too-many-steps': { severity: 'warning', title: 'Слишком длинный сценарий' },
  'undeclared-parameter': { severity: 'error', title: 'Параметр не объявлен' },
  'unused-parameter': { severity: 'warning', title: 'Параметр объявлен впустую' },
  'duplicate-title': { severity: 'warning', title: 'Повтор заголовка в группе' },
  'obsolete-not-archived': { severity: 'warning', title: 'Устаревший кейс не в архиве' },
  'stale-draft': { severity: 'warning', title: 'Черновик залежался' },
  'not-run': { severity: 'info', title: 'Давно не гонялся' },
  'checklist-with-expected': { severity: 'warning', title: 'Чек-лист с ожиданием' },
} satisfies Record<string, { severity: ProjectTestLintSeverity; title: string }>;

/** Идентификатор правила — только из таблицы выше. */
export type ProjectTestLintRule = keyof typeof RULES;

/** Порядок серьёзности: в таком виде замечания и читают. */
const SEVERITY_ORDER: Record<ProjectTestLintSeverity, number> = { error: 0, warning: 1, info: 2 };

const DAY = 24 * 60 * 60 * 1000;

/** Пороги, за которыми правило срабатывает. */
export interface LintOptions {
  /** Момент отсчёта, ISO. Пусто — сейчас. */
  now?: string;
  /** Сколько дней кейсу позволено не гоняться. */
  notRunDays?: number;
  /** Сколько дней черновику позволено оставаться черновиком. */
  draftDays?: number;
  /** Со скольких шагов сценарий считается слишком длинным. */
  maxSteps?: number;
  /** Порог похожести для раздела дубликатов. */
  similarThreshold?: number;
}

const DEFAULT_NOT_RUN_DAYS = 90;
const DEFAULT_DRAFT_DAYS = 30;
const DEFAULT_MAX_STEPS = 15;

/** Пороги после подстановки умолчаний — чтобы не тащить их по всем проверкам. */
interface Limits {
  now: number;
  notRunDays: number;
  draftDays: number;
  maxSteps: number;
}

function finding(
  rule: ProjectTestLintRule,
  groupId: string,
  testCase: ProjectTestCase,
  message: string,
  fix?: ProjectTestLintFinding['fix'],
): ProjectTestLintFinding {
  return {
    rule,
    severity: RULES[rule].severity,
    groupId,
    caseId: testCase.id,
    title: testCase.title,
    message,
    fix,
  };
}

/**
 * Сколько полных дней прошло с отметки. Пусто или мусор вместо даты — `undefined`:
 * «дату не разобрали» и «давно» разные вещи, и путать их нельзя.
 */
function daysSince(now: number, iso?: string): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  return Math.floor((now - at) / DAY);
}

/**
 * Где кейс упоминает параметр: шаги плюс собственные тексты (они подставляются
 * псевдошагом, чтобы грамматика `%имя` осталась одна — из контракта).
 *
 * Смотреть только шаги нельзя: параметр из предусловия или общего ожидания
 * попал бы в «объявлен впустую», а ложное замечание правило и хоронит.
 */
function usedParameters(testCase: ProjectTestCase): Set<string> {
  const own = [testCase.title, testCase.precondition, testCase.expected, testCase.postcondition]
    .filter((text): text is string => Boolean(text))
    .join(' ');
  return new Set(parametersInSteps([...(testCase.steps ?? []), { action: own }]));
}

/** Замечания по описанию кейса: чем доказывается, что и куда привязано. */
function checkShape(
  groupId: string,
  testCase: ProjectTestCase,
  limits: Limits,
): ProjectTestLintFinding[] {
  const found: ProjectTestLintFinding[] = [];
  const steps = testCase.steps ?? [];
  const isCase = testCase.type === 'case';

  // Чек-лист живёт без ожиданий по определению, поэтому оба правила про
  // доказательство результата спрашиваются только с кейса.
  if (isCase && !testCase.oracle?.trim()) {
    found.push(
      finding(
        'no-oracle',
        groupId,
        testCase,
        'Не сказано, чем доказывается результат: проверять придётся «на глаз».',
      ),
    );
  }

  if (isCase) {
    const blind = steps.filter((step) => !step.expected?.trim()).length;
    if (blind > 0) {
      const first = steps.findIndex((step) => !step.expected?.trim()) + 1;
      found.push(
        finding(
          'step-without-expected',
          groupId,
          testCase,
          `Шагов без ожидания: ${blind} (первый — №${first}). Провал такого шага увидеть не на чем.`,
        ),
      );
    }
  }

  if (!isCase && (testCase.expected?.trim() || steps.some((step) => step.expected?.trim()))) {
    found.push(
      finding(
        'checklist-with-expected',
        groupId,
        testCase,
        'У чек-листа заполнено ожидание: либо оно лишнее, либо это кейс, а не чек-лист.',
      ),
    );
  }

  if ((testCase.codePaths ?? []).length === 0) {
    found.push(
      finding(
        'no-code-paths',
        groupId,
        testCase,
        'Нет привязки к коду (`codePaths`): в отбор «прогнать задетое» кейс не попадёт.',
      ),
    );
  }

  if (!testCase.priority) {
    found.push(
      finding(
        'no-priority',
        groupId,
        testCase,
        'Нет приоритета: отбор по важности кейс не увидит.',
        {
          action: 'priority',
          value: 'medium',
          label: 'Проставить приоритет «средний»',
        },
      ),
    );
  }

  if (steps.length > limits.maxSteps) {
    found.push(
      finding(
        'too-many-steps',
        groupId,
        testCase,
        `Шагов ${steps.length} при пороге ${limits.maxSteps}: такой сценарий стоит разбить на несколько.`,
      ),
    );
  }

  return found;
}

/** Замечания по параметрам: объявлено одно, используется другое. */
function checkParameters(groupId: string, testCase: ProjectTestCase): ProjectTestLintFinding[] {
  const found: ProjectTestLintFinding[] = [];
  const declared = new Set((testCase.parameters ?? []).map((item) => item.name).filter(Boolean));
  const used = usedParameters(testCase);

  const undeclared = [...used].filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    found.push(
      finding(
        'undeclared-parameter',
        groupId,
        testCase,
        `В тексте есть ${undeclared.map((name) => `%${name}`).join(', ')}, но в параметрах кейса такого нет — подставлять нечего.`,
      ),
    );
  }

  const unused = [...declared].filter((name) => !used.has(name));
  if (unused.length > 0) {
    found.push(
      finding(
        'unused-parameter',
        groupId,
        testCase,
        `Параметры ${unused.map((name) => `%${name}`).join(', ')} объявлены, но нигде не встречаются: прогон размножится на проходы с одинаковым текстом.`,
      ),
    );
  }

  return found;
}

/** Замечания по состоянию кейса: готовность и давность прогона. */
function checkLifecycle(
  groupId: string,
  testCase: ProjectTestCase,
  limits: Limits,
): ProjectTestLintFinding[] {
  const found: ProjectTestLintFinding[] = [];

  if (testCase.readiness === 'obsolete') {
    found.push(
      finding(
        'obsolete-not-archived',
        groupId,
        testCase,
        'Помечен устаревшим, но лежит среди живых и попадает в прогоны.',
        { action: 'archive', label: 'Убрать в архив' },
      ),
    );
  }

  const draftAge = daysSince(limits.now, testCase.updatedAt);
  if (testCase.readiness === 'draft' && draftAge !== undefined && draftAge > limits.draftDays) {
    found.push(
      finding(
        'stale-draft',
        groupId,
        testCase,
        `Черновик не трогали ${draftAge} дней: он либо давно готов, либо больше не нужен.`,
        { action: 'readiness', value: 'ready', label: 'Пометить готовым' },
      ),
    );
  }

  const runAge = daysSince(limits.now, testCase.lastRunAt);
  if (runAge === undefined) {
    found.push(
      finding(
        'not-run',
        groupId,
        testCase,
        'Ни разу не гонялся: о его результате ничего не известно.',
      ),
    );
  } else if (runAge > limits.notRunDays) {
    found.push(
      finding(
        'not-run',
        groupId,
        testCase,
        `Не гонялся ${runAge} дней: показанный статус давно ничего не доказывает.`,
      ),
    );
  }

  return found;
}

/**
 * Повторы заголовка внутри группы.
 *
 * Замечание вешается на ВТОРОЙ и следующие кейсы, а не на все с этим
 * заголовком: у предложенного действия «в архив» иначе не было бы смысла —
 * убрать надо лишние копии, а не заодно и оригинал.
 */
function checkTitles(group: ProjectTestGroup, cases: ProjectTestCase[]): ProjectTestLintFinding[] {
  const seen = new Map<string, string>();
  const found: ProjectTestLintFinding[] = [];
  for (const testCase of cases) {
    const key = testCase.title.trim().toLowerCase();
    if (!key) continue;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, testCase.id);
      continue;
    }
    found.push(
      finding(
        'duplicate-title',
        group.id,
        testCase,
        `Заголовок повторяет кейс ${first} в этой же группе.`,
        { action: 'archive', label: 'Убрать повтор в архив' },
      ),
    );
  }
  return found;
}

/** Свод по правилам: карточка рисует строки, а не список из тысячи замечаний. */
function rollUp(findings: ProjectTestLintFinding[]): ProjectTestLintReport['byRule'] {
  const counts = new Map<string, number>();
  for (const item of findings) counts.set(item.rule, (counts.get(item.rule) ?? 0) + 1);
  return [...counts.entries()]
    .map(([rule, count]) => ({
      rule,
      severity: RULES[rule as ProjectTestLintRule].severity,
      title: RULES[rule as ProjectTestLintRule].title,
      count,
    }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        b.count - a.count ||
        a.rule.localeCompare(b.rule),
    );
}

/**
 * Проверить библиотеку целиком.
 *
 * Архивные кейсы не проверяются: архив и есть способ сказать «этот кейс больше
 * не наш», и замечания на нём были бы вечным шумом. Нечитаемая группа
 * пропускается — её содержимого панель не знает, и молчать честнее, чем
 * записать в отчёт догадку.
 */
export function lintLibrary(
  groups: ProjectTestGroup[],
  options: LintOptions = {},
): ProjectTestLintReport {
  const checkedAt = options.now ?? new Date().toISOString();
  const limits: Limits = {
    now: Date.parse(checkedAt),
    notRunDays: options.notRunDays ?? DEFAULT_NOT_RUN_DAYS,
    draftDays: options.draftDays ?? DEFAULT_DRAFT_DAYS,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
  };

  const findings: ProjectTestLintFinding[] = [];
  let checked = 0;

  for (const group of groups) {
    if (group.error) continue;
    const cases = group.cases.filter((testCase) => !testCase.archived);
    checked += cases.length;
    for (const testCase of cases) {
      findings.push(...checkShape(group.id, testCase, limits));
      findings.push(...checkParameters(group.id, testCase));
      findings.push(...checkLifecycle(group.id, testCase, limits));
    }
    findings.push(...checkTitles(group, cases));
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.groupId.localeCompare(b.groupId) ||
      a.caseId.localeCompare(b.caseId) ||
      a.rule.localeCompare(b.rule),
  );

  return {
    findings,
    byRule: rollUp(findings),
    duplicates: similarCases(groups, { threshold: options.similarThreshold }),
    checked,
    checkedAt,
  };
}
