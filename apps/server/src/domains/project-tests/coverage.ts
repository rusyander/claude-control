import type {
  ProjectTestCase,
  ProjectTestCoverage,
  ProjectTestCoverageCase,
  ProjectTestCoverageItem,
  ProjectTestGroup,
} from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { toAccess } from '../integrations/atlassian/client.ts';
import { searchIssues } from '../integrations/atlassian/jira.ts';
import { linkForCwd } from '../integrations/links.ts';
import { readIntegrations, readToken } from '../integrations/store.ts';

/**
 * Матрица покрытия: требование → кейсы → последний результат.
 *
 * Это единственный вид, отвечающий на вопрос «что мы вообще не проверяем».
 * Список кейсов отвечает на обратный — «что мы проверяем», — и по нему дыру не
 * видно: отсутствующего кейса в списке кейсов нет по определению.
 *
 * Требования берутся из ССЫЛОК кейсов (`links[type=requirement|issue]`), а
 * когда подключён Atlassian — ещё и из Jira по запросу. Второй источник и
 * приносит главное: задачи, на которые не сослался никто. Без него пустой
 * `cases` невозможен в принципе, и матрица показывает лишь то, что уже связано.
 */

/** Ссылки кейса, из которых получается требование. */
const REQUIREMENT_LINKS = new Set(['requirement', 'issue']);

/**
 * Ключ требования: `QA-42` из адреса Jira, иначе сам адрес.
 *
 * Ключ важнее адреса, потому что на одну задачу ссылаются по-разному —
 * `/browse/QA-42`, `/jira/software/projects/QA/issues/QA-42`, ссылка из письма.
 * Разные строки одного требования разложили бы матрицу на два столбца, и дыра
 * посередине выглядела бы как две наполовину закрытые.
 */
export function requirementKey(url: string): string {
  const jira = url.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i);
  if (jira?.[1]) return jira[1].toUpperCase();
  const inPath = url.match(/[?&/]([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/);
  if (inPath?.[1]) return inPath[1].toUpperCase();
  return url.trim();
}

function toCoverageCase(groupId: string, item: ProjectTestCase): ProjectTestCoverageCase {
  return {
    groupId,
    caseId: item.id,
    title: item.title,
    status: item.status,
    muted: item.muted,
    lastRunAt: item.lastRunAt,
  };
}

function emptyCounts(): ProjectTestCoverageItem['counts'] {
  return { passed: 0, failed: 0, blocked: 0, skipped: 0, unknown: 0 };
}

function countIn(counts: ProjectTestCoverageItem['counts'], item: ProjectTestCoverageCase): void {
  if (item.status === 'passed') counts.passed += 1;
  else if (item.status === 'failed') counts.failed += 1;
  else if (item.status === 'blocked') counts.blocked += 1;
  else if (item.status === 'skipped') counts.skipped += 1;
  // `running` считается непроверенным: результата у него ещё нет, и записывать
  // идущий прогон в зелень значило бы обещать то, чего никто не видел.
  else counts.unknown += 1;
}

export interface CoverageDeps {
  store: AppStore;
  appDataDir: string;
  root: string;
}

export interface CoverageOptions {
  /** Запрос JQL для списка требований; пусто — взять из привязки проекта. */
  jql?: string;
  /** Не ходить в Jira, даже если она подключена (тесты, оффлайн). */
  linksOnly?: boolean;
}

/**
 * Собрать матрицу.
 *
 * Архивные кейсы не участвуют: требование, закрытое только архивным кейсом, не
 * покрыто ничем — и показывать его закрытым было бы враньём ровно в том месте,
 * ради которого матрицу и открывают.
 */
export async function buildCoverage(
  deps: CoverageDeps,
  groups: ProjectTestGroup[],
  options: CoverageOptions = {},
): Promise<ProjectTestCoverage> {
  const items = new Map<string, ProjectTestCoverageItem>();
  const orphans: ProjectTestCoverageCase[] = [];

  for (const group of groups) {
    if (group.error) continue;
    for (const item of group.cases) {
      if (item.archived) continue;
      const links = (item.links ?? []).filter((link) => REQUIREMENT_LINKS.has(link.type));
      const view = toCoverageCase(group.id, item);
      if (links.length === 0) {
        orphans.push(view);
        continue;
      }
      for (const link of links) {
        const key = requirementKey(link.url);
        const current = items.get(key) ?? {
          key,
          url: link.url,
          title: link.title,
          cases: [],
          counts: emptyCounts(),
        };
        // Заголовок из ссылки берём первый непустой: одна и та же задача бывает
        // подписана и по-человечески, и голым ключом.
        if (!current.title && link.title) current.title = link.title;
        current.cases.push(view);
        countIn(current.counts, view);
        items.set(key, current);
      }
    }
  }

  const fromJira = options.linksOnly ? undefined : await requirementsFromJira(deps, options.jql);
  if (fromJira?.issues) {
    for (const issue of fromJira.issues) {
      const current = items.get(issue.key);
      if (current) {
        current.title = current.title ?? issue.summary;
        current.url = current.url ?? issue.url;
        current.status = issue.status;
        continue;
      }
      items.set(issue.key, {
        key: issue.key,
        url: issue.url,
        title: issue.summary,
        status: issue.status,
        cases: [],
        counts: emptyCounts(),
      });
    }
  }

  return {
    // Непокрытые — вверх: матрица открывается ради них.
    items: [...items.values()].sort(byRisk),
    orphans,
    source: fromJira?.issues ? 'jira' : 'links',
    jql: fromJira?.jql,
    warning: fromJira?.warning,
    warningCode: fromJira?.warningCode,
    warningParams: fromJira?.warningParams,
  };
}

/**
 * Порядок строк: сначала ничем не покрытые, потом красные, потом остальные.
 * Ровно тот порядок, в котором на них смотрят.
 */
function byRisk(a: ProjectTestCoverageItem, b: ProjectTestCoverageItem): number {
  const rank = (item: ProjectTestCoverageItem): number => {
    if (item.cases.length === 0) return 0;
    if (item.counts.failed > 0 || item.counts.blocked > 0) return 1;
    if (item.counts.unknown > 0) return 2;
    return 3;
  };
  return rank(a) - rank(b) || a.key.localeCompare(b.key);
}

interface JiraRequirements {
  issues?: { key: string; summary: string; status: string; url: string }[];
  jql?: string;
  warning?: string;
  warningCode?: string;
  warningParams?: Record<string, string | number>;
}

/**
 * Требования из Jira. Запрос берётся из привязки проекта: панель не выдумывает
 * ни проект, ни фильтр — сослаться на чужой проект хуже, чем не показать
 * ничего.
 */
async function requirementsFromJira(
  deps: CoverageDeps,
  jqlOverride?: string,
): Promise<JiraRequirements> {
  const settings = readIntegrations(deps.store).atlassian;
  const token = readToken(deps.appDataDir, 'atlassian');
  if (!settings.enabled || !token) {
    return {
      warning: 'Atlassian не подключён: показаны только требования из ссылок кейсов.',
      warningCode: 'coverage-atlassian-off',
    };
  }

  const link = linkForCwd(deps.store, deps.root)?.link;
  const jql = jqlOverride?.trim() || defaultJql(link?.jiraProjectKey, link?.jiraIssueKey);
  if (!jql) {
    return {
      warning: 'К проекту не привязан проект Jira: показаны только требования из ссылок кейсов.',
      warningCode: 'coverage-jira-project-unlinked',
    };
  }

  try {
    const issues = await searchIssues(toAccess(settings, token), { jql, limit: 100 });
    return {
      issues: issues.map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        url: issue.url,
      })),
      jql,
    };
  } catch (error) {
    // Jira не ответила — матрица всё равно собирается по ссылкам. Отказ здесь
    // не повод отдать пустой экран: половина ответа полезнее нуля.
    return {
      jql,
      warning: `Jira не ответила: ${error instanceof Error ? error.message : error}`,
      warningCode: 'coverage-jira-failed',
      warningParams: { reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** Ключи требований, на которые ссылаются живые кейсы. */
export function linkedRequirements(groups: ProjectTestGroup[]): string[] {
  const keys = new Set<string>();
  for (const group of groups) {
    if (group.error) continue;
    for (const item of group.cases) {
      if (item.archived) continue;
      for (const link of item.links ?? []) {
        if (REQUIREMENT_LINKS.has(link.type)) keys.add(requirementKey(link.url));
      }
    }
  }
  return [...keys];
}

/** Только то, что Jira примет за ключ задачи: `QA-42`, а не адрес целиком. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * Когда требования правили в трекере.
 *
 * Спрашиваем ровно по тем ключам, на которые сослались кейсы, а не по запросу
 * проекта: расхождение ищется у кейса, и задача, на которую никто не сослался,
 * к нему отношения не имеет. Ответа нет — возвращаем оговорку: раздел тестов
 * обязан работать и без единой интеграции.
 */
export async function requirementUpdates(
  deps: CoverageDeps,
  keys: string[],
): Promise<{
  updates: Record<string, { updatedAt: string; url?: string }>;
  warning?: string;
  warningCode?: string;
  warningParams?: Record<string, string | number>;
}> {
  const known = keys.filter((key) => ISSUE_KEY.test(key));
  if (known.length === 0) return { updates: {} };

  const settings = readIntegrations(deps.store).atlassian;
  const token = readToken(deps.appDataDir, 'atlassian');
  if (!settings.enabled || !token) {
    return {
      updates: {},
      warning: 'Atlassian не подключён: даты требований не сверялись.',
      warningCode: 'coverage-dates-atlassian-off',
    };
  }

  try {
    const issues = await searchIssues(toAccess(settings, token), {
      jql: `key in (${known.slice(0, 100).join(', ')})`,
      limit: 100,
    });
    const updates: Record<string, { updatedAt: string; url?: string }> = {};
    for (const issue of issues) {
      if (issue.updatedAt) updates[issue.key] = { updatedAt: issue.updatedAt, url: issue.url };
    }
    return { updates };
  } catch (error) {
    return {
      updates: {},
      warning: `Jira не ответила, даты требований не сверялись: ${error instanceof Error ? error.message : error}`,
      warningCode: 'coverage-dates-jira-failed',
      warningParams: { reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Запрос по умолчанию: дети привязанного эпика, иначе открытые задачи проекта.
 * `ORDER BY` намеренно по ключу — человек ищет строку глазами, а не по дате.
 */
function defaultJql(projectKey?: string, issueKey?: string): string {
  if (issueKey) return `parent = ${issueKey} ORDER BY key ASC`;
  if (projectKey) return `project = ${projectKey} AND statusCategory != Done ORDER BY key ASC`;
  return '';
}
